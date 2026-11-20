import { describe, expect, it } from 'vitest'
import { validateScene } from '../../core/scene/scene'
import { AGV_TINE_HEEL, AGV_TINE_LENGTH, AGV_TINE_RISE, AGV_TINE_THICKNESS, PALLET_POCKET_HEIGHT, PALLET_SIZE, ROLLER_CLASSES, STAIRS_STANDARD_RISE, STAIRS_STANDARD_TREAD } from '../../core/types'
import { computeStructureConnections } from '../../core/structureConnections'
import { compile, LocalPlcLink, runnableSource, unhandledProgramTags } from '../../plc'
import type { Controller } from '../../core/controller'
import { checkWiring } from '../../plc/wiring'
import { ladderExportCaveats } from '../../plc/ladder/ladder'
import { lex } from '../../plc/lexer'
import { parse } from '../../plc/parser'
import { findSnap } from '../../core/snap/snapFeatures'
import { conveyorEndsOf, flexPathOf, partFootprint, toLocalXZ, toWorldXZ } from '../../core/parts/partGeometry'
import { flexStations } from '../../core/conveyor/flexPath'
import { dockOpeningBlocker, dockOpenings, openDockOpenings, personnelDoors } from '../../core/building/buildingDocks'
import { legStations } from '../../render/parts/common'
import { registerPackage } from '../../core/parts/partRegistry'
import { LAYER_PATTERN, AGV_PICK_BASE, AGV_WAY_BASE, RACK_BAY_BASE, RACK_ROUTE, RACK_SLOTS, RACK_WAYS, SUPPLY, SUPPLY_ROUTE, SUPPLY_STACK, SUPPLY_STOCK_Z, ARM_REACH_WEST_X, ARM_REACH_X, CARRY, carriedLoadSpot, CELL, createPlcDemoScene, DEMO_CONTROLLER, DEMO_PROGRAM, PALLETIZER, SWING_RADIUS, TURN_CLEARANCE } from './demoScenes'
import { DEMO_REFERENCE_PROGRAM, LADDER_REFERENCE_CONTROLLER, ST_REFERENCE_CONTROLLER } from './demoReference'
import type { PartInstance } from '../../core/types'
import { UNIT_LAYER } from '../../core/frame'

/** A REAL setpoint as the PLC actually holds it. IEC REAL is single precision, so a program
 *  that assigns 0.4 stores 0.4000000059604645 - on this engine and on the hardware alike.
 *  Comparing against the f64 literal would be asserting a value no PLC can represent. */
const real = (x: number): number => Math.fround(x)

/** The demo is built entirely from bundled SDK parts placed as `custom` instances - pick one by its
 *  package id (there are no built-in device types left to match on). */
const pkgId = (p: PartInstance): string | undefined => (p as { packageId?: string }).packageId
const byPkg = (parts: PartInstance[], id: string): PartInstance[] => parts.filter((p) => p.type === 'part' && pkgId(p) === id)
const paramsOf = (p: PartInstance): Record<string, unknown> => p.params as Record<string, unknown>
/** the line's emergency stops, one chain: the operator station's, the trailer's, the gate's, the pallet supply's, the outfeed's */
const ESTOPS = ['EStop', 'EStopDock', 'EStopGate', 'EStopSupply', 'EStopOutfeed']

/** The cell's east run, out of the fences given. The south run's return to the case line is rotated too, so it is
 *  the rotated run at the greatest x, which is the boundary edge. */
const eastRun = (fences: PartInstance[]): PartInstance =>
  fences.filter((p) => p.rotationY !== 0).sort((a, b) => b.position[0]! - a.position[0]!)[0]!

const SCAN = 0.1 // s per PLC scan, as the sim interleaves it

/** The demo program as the Controller runs it (its table's CONFIGURATION appended), with Main's variables read by
 *  their bare names as the cell's own tags are: `Step` is `Main.Step`, `Tower` the controller's tag. */
function compileDemo(controller: Controller = DEMO_CONTROLLER): Pick<ReturnType<typeof compile>, 'get' | 'setInput' | 'scan'> {
  const p = compile(runnableSource(DEMO_PROGRAM, controller))
  return {
    get: (name) => p.get(name) ?? p.get(`Main.${name}`),
    setInput: (name, value) => p.setInput(name, value),
    scan: (dt) => p.scan(dt),
  }
}

/** The demo program's link as Play attaches it: through its controller table. */
const demoLink = (): LocalPlcLink => new LocalPlcLink(runnableSource(DEMO_PROGRAM, DEMO_CONTROLLER))

/**
 * The route rows the PalletTruck block sends, in order, for one trip to bay `slot` of truck `key`: home, the
 * corners out to its lane, the five-row pick, the corners to the bay, the bay's four rows, the corners home,
 * home. Shared by every spec that walks a truck's path, because a spec that walks the bare pick/bay rows is
 * checking a path no truck drives - the corners are where it turns, and turning is where the clearances are.
 */
const commandOrder = (slot: number): number[] => {
  const w = RACK_WAYS
  const bay = RACK_BAY_BASE + 4 * slot
  const ways = (from: number, n: number): number[] => Array.from({ length: n }, (_, i) => AGV_WAY_BASE + from + i)
  return [
    0, ...ways(0, w.out),
    AGV_PICK_BASE, AGV_PICK_BASE + 1, AGV_PICK_BASE + 2, AGV_PICK_BASE + 3, AGV_PICK_BASE + 4,
    ...ways(w.out, w.mid), bay, bay + 1, bay + 2, bay + 3,
    ...ways(w.out + w.mid, w.in), 0,
  ]
}

/** Headless driver for the demo program: sticky inputs, stepped a scan at a time. */
function runner() {
  const p = compileDemo()
  const inputs: Record<string, boolean> = {
    Start: false, Stop: true, Guard: true, BoxAtEye: false, RowReady: false, LayerReady: false,
    ArmIdle: true, TurnDone: true, TurnEye: false, LaneFull: false,
    RackIdle: true, SupplyIdle: true, PalletIn: true, DispBusy: false, PalletReady: false, LoadOut: false,
    WrapInPos: false, WrapDone: false, FlexFull: false,
  }
  // the stretch wrapper, as a plant: scans the load has been travelling toward its station, and scans it has been
  // told to wrap (the machine itself, and the film it lays on the load, are the physics run's to prove). At this
  // scan the load's 2.7 m from the build deck to the station at 0.4 m/s is ~65 scans, and a wrap cycle ~20 s.
  const WRAP_TRAVEL_SCANS = 65
  const WRAP_CYCLE_SCANS = 200
  let wrapTravel = 0
  let wrapTime = 0
  const step = (over: Record<string, boolean> = {}, scans = 1): void => {
    Object.assign(inputs, over)
    for (let i = 0; i < scans; i++) {
      for (const [k, v] of Object.entries(inputs)) p.setInput(k, v)
      p.scan(SCAN)
      // the pallet line, as a plant: a finished load carried off leaves the deck at once, passing the off-deck eye
      // (one scan covered, then clear); a commanded feed then lands a pallet against the stop at once (the dispenser,
      // the infeed and the transfer are the physics run's to prove, demoScenesSim.test.ts)
      if (inputs['LoadOut']) inputs['LoadOut'] = false
      else if (inputs['PalletIn'] && p.get('palletFull') === true && p.get('outRun') === true && p.get('PalletFeed') !== true) {
        inputs['PalletIn'] = false
        inputs['LoadOut'] = true
      }
      if (p.get('PalletFeed') === true) inputs['PalletIn'] = true
      // the load reaches the wrapper's station eye a few scans after it sets off, stands there while it is wrapped,
      // and a started wrap is done a few scans later, until the load leaves the station
      const out = p.get('OutStep')
      wrapTravel = out === 106 && p.get('outRun') === true ? wrapTravel + 1 : 0
      wrapTime = p.get('WrapStart') === true ? wrapTime + 1 : 0
      inputs['WrapInPos'] = (out === 106 && wrapTravel >= WRAP_TRAVEL_SCANS) || out === 107
      inputs['WrapDone'] = out === 107 && wrapTime >= WRAP_CYCLE_SCANS
    }
  }
  /** run until `until` holds (or `max` scans), reporting whether the tag ever went true on the way */
  const runWhile = (max: number, watch?: string, until?: () => boolean): boolean => {
    let seen = false
    for (let i = 0; i < max; i++) {
      step()
      if (watch && p.get(watch) === true) seen = true
      if (until && until()) break
    }
    return seen
  }
  /** one case passes the arrival eye (a one-scan beam break) */
  const sendCase = (): void => {
    step({ BoxAtEye: true })
    step({ BoxAtEye: false })
  }
  /** the row packs against the stop and the chain transfer pushes it aside; leaves the row eye clear again and
   *  the layer eye covered, since a row is now parked on the layer stop */
  const pushRow = (): void => {
    step({ RowReady: true }, 18) // the RowPacked debounce is 1 s: long enough that only a stopped case satisfies it
    expect(p.get('Shift')).toBe(true)
    for (let i = 0; i < 30 && p.get('Shift') === true; i++) step() // the 2 s push
    step({ RowReady: false, LayerReady: true })
  }
  /**
   * The scene ships a finished load already standing on the build deck, so the program opens in its discharge
   * step rather than at 0. Run that opening load out - through the turntable, onto the lane, and away on the
   * truck - so a test about the case line starts from a settled, empty cell instead of mid-cycle.
   */
  /** drive one truck's move/idle handshake until its dispatcher is back at rest */
  const runTruck = (): void => {
    for (let i = 0; i < 40 && p.get('TruckStep') !== 0; i++) {
      step({ RackIdle: false }, 2)
      step({ RackIdle: true }, 8) // long enough for the fork dwells to elapse
    }
  }
  /** carry the load on through the stretch wrapper: stopped at its station, wrapped, and on toward the turntable */
  const wrapOut = (): void => {
    for (let i = 0; i < 400 && p.get('OutStep') !== 110; i++) step()
  }
  const clearPrestaged = (): void => {
    for (let i = 0; i < 12 && p.get('outRun') !== true; i++) step()
    wrapOut()
    step({ TurnEye: true }, 2)
    for (let i = 0; i < 12 && p.get('laneRun') !== true; i++) step()
    step({ LaneFull: true }, 2)
    for (let i = 0; i < 40 && p.get('palletFull') !== false; i++) step()
    step({ TurnEye: false, LaneFull: false }, 2) // the truck lifts it clear of the lane
    runTruck() //                                  ...and runs it to the racks and back
  }
  clearPrestaged()
  return { p, step, runWhile, sendCase, pushRow, runTruck, wrapOut }
}

describe('PLC demo scene', () => {
  it('produces a scene the editor accepts', () => {
    expect(validateScene(createPlcDemoScene()).ok).toBe(true)
  })

  it('is built entirely from bundled SDK parts (only meta nodes + the building shell are built-in)', () => {
    const scene = createPlcDemoScene()
    // `annotation` joins `group` here for the reason that distinction exists: it is a meta node, not a piece
    // of equipment. An SDK part is geometry + behavior and a note has neither, so there is nothing for a
    // package to hold. What this test forbids is a conveyor or a sensor living on as engine code after the
    // convergence - a screen-space caption is not that.
    const nonSdk = scene.parts.filter((p) => p.type !== 'part' && p.type !== 'group' && p.type !== 'building' && p.type !== 'annotation')
    expect(nonSdk).toEqual([])
    // and the scene embeds the packages it uses, so it loads self-contained
    const embedded = new Set((scene.packages ?? []).map((pk) => pk.id))
    for (const id of ['oip.roller-conveyor', 'oip.six-axis-robot', 'oip.chain-transfer', 'oip.agv']) {
      expect(embedded.has(id), id).toBe(true)
    }
  })

  it('gives siblings unique names (the unique-name rule store.rename enforces - no duplicate rows under one parent)', () => {
    const parts = createPlcDemoScene().parts
    const byParent = new Map<string | undefined, string[]>()
    for (const p of parts) {
      if (!p.name) continue
      const arr = byParent.get(p.parent) ?? []
      arr.push(p.name)
      byParent.set(p.parent, arr)
    }
    for (const [, names] of byParent) expect(new Set(names).size).toBe(names.length)
    // per-branch, not global: each pallet stack restarts its pallets at "Pallet", so "Pallet" recurs > once
    expect(parts.filter((p) => p.name === 'Pallet').length).toBeGreaterThan(1)
  })

  it('includes the layer-forming line: the case beds, the turning plow, a chain transfer, one stop, a 3-tier tower', () => {
    const parts = createPlcDemoScene().parts
    // two CASE beds - the infeed and the row-former bed the chain bank sits in - and four carrying pallets: the
    // empty-pallet infeed, the build deck, the run out of the cell, and the staging lane
    const beds = byPkg(parts, 'oip.roller-conveyor')
    const caseBeds = ['Infeed', 'Row former']
    expect(beds.filter((p) => caseBeds.includes(p.name!))).toHaveLength(2)
    expect(beds.filter((p) => !caseBeds.includes(p.name!))).toHaveLength(4)
    // and every one that carries a load is at the same height. The pallet line is level with the case line on
    // purpose: a load cannot step between decks, so it never changes level between being built and being carried
    // away - and that one height is what the arm's poses are solved against.
    const infeed = beds.find((b) => b.name === 'Pallet infeed')!
    for (const b of beds) if (b !== infeed) expect(paramsOf(b).standHeight).toBe(CELL.surface)
    expect(CELL.palletDeckH).toBe(CELL.surface)
    // The one exception carries an empty pallet onto the build deck from the side, and stands exactly as high as the
    // pallet transfer's chains are when raised (seated chainDropZ under the rollers, a 0.095 m stroke), so the pallet
    // steps straight off its last roller onto them; lowered, they leave it on the deck.
    const xfer = parts.find((p) => p.name === 'Pallet transfer')!
    expect(paramsOf(infeed).standHeight).toBeCloseTo(xfer.position[1] + 0.095, 9)
    expect(xfer.position[1]).toBeCloseTo(CELL.palletDeckH - CELL.chainDropZ, 9)
    expect(byPkg(parts, 'oip.diverter')).toHaveLength(1) // used as a turning plow, not a push-off
    // two chain transfers: the layer former in the case bed, and the pallet transfer in the build deck
    expect(byPkg(parts, 'oip.chain-transfer').map((p) => p.name).sort()).toEqual(['Layer former', 'Pallet transfer'])
    // One blade stop - the row stop, which squares cases along the line. What squares a pushed row across it is the
    // row former's own +z side guard, so there is no second stop standing in the bed for the arm to lift past.
    expect(byPkg(parts, 'oip.blade-stop')).toHaveLength(1)
    const tower = byPkg(parts, 'oip.stack-light')[0]!
    expect(paramsOf(tower).segments).toBe(3)
    expect(paramsOf(tower).tag).toBe('Tower')
  })

  // The tower is the one device at the operator station with nothing to bolt to - the buttons sit on the infeed's
  // side guard, it does not - so it was placed by hand at 2.03 m and hung there over open air, 1 m above the bed
  // and inboard of the deck edge. It now stands on the cell fence, and this pins what keeps it standing: it is on
  // a post one of the runs actually draws (a run gives up an end post to a neighbour with omitPost*, and a light
  // over a post that was given away is back to hanging in air), at the height the steel actually ends.
  it('stands the status tower on a cell fence post rather than over the lane', () => {
    const parts = createPlcDemoScene().parts
    const tower = byPkg(parts, 'oip.stack-light')[0]!
    const [tx, ty, tz] = tower.position as [number, number, number]
    // every fence end, as [x, z, drawn?]: a run posts both ends of its own length, minus the ones it omits
    const ends = byPkg(parts, 'oip.fence').flatMap((f) => {
      const p = paramsOf(f)
      const half = (p.length as number) / 2
      const yaw = f.rotationY ?? 0
      // local +X under a rotationY of yaw
      const ax = Math.cos(yaw) * half, az = -Math.sin(yaw) * half
      return [
        { x: f.position[0]! - ax, z: f.position[2]! - az, drawn: p.omitPostStart !== true, height: p.height ?? 2 },
        { x: f.position[0]! + ax, z: f.position[2]! + az, drawn: p.omitPostEnd !== true, height: p.height ?? 2 },
      ]
    })
    // more than one run can end here (the south run and the return that closes the boundary down to the case
    // line share this corner), so check whether any of them draws the post, not what the first one does
    const meeting = ends.filter((e) => Math.hypot(e.x - tx, e.z - tz) < 1e-6)
    expect(meeting.length).toBeGreaterThan(0)
    expect(meeting.some((e) => e.drawn)).toBe(true)
    // ...and exactly once: a shared corner that draws twice is coincident steel, coincident caps
    expect(meeting.filter((e) => e.drawn).length).toBe(1)
    const post = meeting.find((e) => e.drawn)
    // its foot stands on the post's cap (0.03 m over the run's height), not on the bare post top or in mid-air
    expect(ty).toBeCloseTo((post!.height as number) + 0.03, 9)
    // ...which is still tall enough to be a signal tower: the lenses clear the deck the cases ride on
    expect(ty).toBeGreaterThan(CELL.surface + 0.8)
    // and it needs no mast of its own
    expect(parts.find((p) => p.name === 'Status tower mast')).toBeUndefined()
  })

  it('sets the diverter up as a turning plow: a stroke that reaches into the lane, not a push-off', () => {
    const turner = byPkg(createPlcDemoScene().parts, 'oip.diverter')[0]!
    const reach = paramsOf(turner).divertDistance as number
    // it has to protrude far enough to catch a case's near edge (the lane half-width is 0.762 and the arm's own
    // geometry eats ~0.875 of the stroke) but nowhere near far enough to shove a case off the bed
    expect(reach).toBeGreaterThan(0.5)
    expect(reach).toBeLessThan(0.9)
  })

  // Both infeed rails stay up. The -z one is the datum a turning case squares against; the +z one is the side the
  // plow reaches through, and it can stay because the plow's telescoping arms carry no collider at all - only its
  // blade has a body, and that body is a kinematic link, so it never resolves against a static guard. Dropping the
  // rail to make room would just open a side for cargo to be shoved off.
  it('keeps both infeed rails: the plow crosses a guarded side without fighting it', () => {
    const infeed = byPkg(createPlcDemoScene().parts, 'oip.roller-conveyor').find((p) => p.name === 'Infeed')!
    expect(paramsOf(infeed).leftGuard).toBe(true)
    expect(paramsOf(infeed).rightGuard).toBe(true)
  })

  // Both rows form on the lane centreline - nothing positions a case laterally, the trailer flex delivers it there
  // and the rollers carry it straight - and one push sets them flush. The push must go opposite the plow, which
  // deflects a turning case -z: push the same way and the next row forms into the one already parked there.
  it('delivers each case onto the forming lane, and pushes rows opposite the way the plow deflects', () => {
    const parts = createPlcDemoScene().parts
    const flex = parts.find((p) => p.name === 'Trailer flex')!
    const g = flexPathOf(flex)!
    // a straight bed down the lane: every point on its centreline
    expect(flex.position[2]).toBeCloseTo(CELL.laneZ, 6)
    for (const [, z] of g.points) expect(z).toBeCloseTo(0, 9)
    // the layer stop is on the +z side: rows are pushed away from the plow's deflection
    expect(CELL.layerStopZ).toBeGreaterThan(CELL.laneZ)
  })

  // The flow runs one way from the dock: the shell is turned so its receiving door is ON the forming lane, open, and
  // the flex runs straight out of the trailer through it onto the infeed tail, stocked so the line is fed at once.
  it('runs the trailer flex straight out of the open receiving door onto the infeed, stocked', () => {
    const parts = createPlcDemoScene().parts
    const shell = parts.find((p) => p.type === 'building')!
    const door = openDockOpenings(shell as never)
    expect(door.map((d) => d.key)).toEqual(['1:0'])
    const doorW = toWorldXZ(shell, door[0]!.x, door[0]!.z)
    expect(doorW.z).toBeCloseTo(CELL.laneZ, 6)
    const flex = parts.find((p) => p.name === 'Trailer flex')!
    const infeed = parts.find((p) => p.name === 'Infeed')!
    // the real part: a flex package that fails to build leaves an empty group of the same name (placeSdk's fallback),
    // and everything placed off its path - the case source, the queue - then lands somewhere meaningless
    expect(pkgId(flex)).toBe('oip.flex-conveyor')
    // its infeed is in the trailer, outside the dock wall; its end meets the infeed tail (the deck overlap + a gap)
    expect(flex.position[0]).toBeLessThan(doorW.x - 2)
    const g = flexPathOf(flex)!
    const fit = flexStations(g.points, g.sections)
    expect(fit.maxHinge).toBeLessThan(1e-9)
    const len = (paramsOf(flex) as { length: number }).length
    expect(len).toBeCloseTo(fit.pitch * g.sections, 6)
    expect(len).toBeLessThanOrEqual(24)
    const endX = toWorldXZ(flex, g.points[g.points.length - 1]![0], 0).x
    const tailX = infeed.position[0] - (paramsOf(infeed) as { length: number }).length / 2
    expect(tailX - endX).toBeGreaterThan(0.06)
    expect(tailX - endX).toBeLessThan(0.1)
    // stocked with a queue, grouped with it, one to a zone, and every one on the bed (inside the building or out)
    const stocked = parts.filter((p) => p.parent === flex.parent && pkgId(p) === 'oip.box')
    expect(stocked.length).toBeGreaterThan(4)
    for (const c of stocked) {
      expect(c.position[2]).toBeCloseTo(CELL.laneZ, 6)
      expect(c.position[0]).toBeGreaterThan(flex.position[0])
      expect(c.position[0]).toBeLessThan(endX)
    }
    const xs = stocked.map((c) => c.position[0]).sort((a, b) => a - b)
    for (let i = 1; i < xs.length; i++) expect(xs[i]! - xs[i - 1]!).toBeCloseTo(fit.pitch, 6)
    // the unloader puts each case down a whole case and a gap behind the first zone's eye, whose covering is the flex's
    // full signal: so while the eye is clear, the spot a case lands on is too, and none can land on the one before
    const source = parts.find((p) => p.name === 'Case source')!
    const caseLen = (paramsOf(source) as { length: number }).length
    const eye0 = toWorldXZ(flex, 0.8 * fit.pitch, 0).x
    expect(eye0 - (source.position[0] + caseLen / 2)).toBeGreaterThanOrEqual(0.3 - 1e-9)
    expect(source.position[0] - caseLen / 2).toBeGreaterThan(flex.position[0] - 0.07) // ...and on the bed, not behind it
  })

  // The receiving door cannot be shut on the flex that runs out through it (walk mode's Use, store.toggleWalkDoorLeaf);
  // the second door, beside the pallet supply, has nothing in it and closes.
  it('blocks the receiving door with the trailer flex, and only that door', () => {
    const parts = createPlcDemoScene().parts
    const shell = parts.find((p) => p.type === 'building')!
    expect(dockOpeningBlocker(shell as never, '1:0', parts)).not.toBeNull()
    // the flex alone holds it (a stocked case may stand in the doorway too, and would hold it as well)
    const noCases = parts.filter((p) => pkgId(p) !== 'oip.box')
    expect(dockOpeningBlocker(shell as never, '1:0', noCases)?.name).toBe('Trailer flex')
    expect(dockOpeningBlocker(shell as never, '1:1', parts)).toBeNull()
  })

  // Everything stands inside the shell. The shell is placed round the flow (turned, its receiving door on the lane),
  // so a part placed without regard to the shell can end up in the car park, or in a wall, or across the flex's path,
  // and nothing else notices. Only the trailer end of the unloading is outside, in the
  // trailer, which is the point of it.
  it('keeps every part inside the building, but for the trailer end of the unloading', () => {
    const scene = createPlcDemoScene()
    const shell = scene.parts.find((p) => p.type === 'building')!
    const bp = shell.params as { lengthSections: number; widthSections: number }
    const halfL = (bp.lengthSections * 10) / 2, halfW = (bp.widthSections * 10) / 2
    const byId = new Map(scene.parts.map((p) => [p.id, p]))
    const inUnloading = (p: PartInstance): boolean => {
      for (let q: PartInstance | undefined = p; q; q = q.parent ? byId.get(q.parent) : undefined) if (q.name === 'Trailer unloading') return true
      return false
    }
    const outside: string[] = []
    for (const p of scene.parts) {
      if (p.type === 'building' || p.type === 'group' || inUnloading(p)) continue
      const l = toLocalXZ(shell, p.position[0], p.position[2])
      if (Math.abs(l.x) > halfL - 0.3 || Math.abs(l.z) > halfW - 0.3) outside.push(`${p.name} (${p.position[0].toFixed(1)}, ${p.position[2].toFixed(1)})`)
    }
    expect(outside).toEqual([])
    // ...and the unloading's parts that are outside are out through the receiving door: on its line, in the trailer -
    // or, the E-stop, on the flex's leg beside it (half the flex's 0.5 m, the leg's 0.082, the box's 0.0317) - or a case
    // of the load still in the trailer, inside its 2.35 m (render/parts/dockDoor.ts ContainerTrailer.glb) and its 11.6 m
    const door = openDockOpenings(shell as never)[0]!
    const nose = toWorldXZ(shell, door.x, door.z).x - 11.6
    for (const p of scene.parts.filter(inUnloading)) {
      if (p.type === 'group') continue
      if (p.parent && byId.get(p.parent)?.name === 'Trailer load') {
        expect(Math.abs(p.position[2] - CELL.laneZ) + 0.2, p.name).toBeLessThan(2.345 / 2)
        expect(p.position[0] - 0.3, p.name).toBeGreaterThan(nose)
        continue
      }
      expect(Math.abs(p.position[2] - CELL.laneZ), p.name).toBeLessThan(p.name === 'Dock E-stop' ? 0.37 : 0.01)
    }
  })

  // The chain deck rides its lift joint (a joint-driven conveys link is kinematic, world.ts attachRigConveyors),
  // so it must start below the roller line: seated flush the two surfaces are coplanar, a case touches both, and
  // whichever is idle brakes it.
  it('seats the chain bank below the roller line so the two surfaces are never coplanar', () => {
    const parts = createPlcDemoScene().parts
    const chain = byPkg(parts, 'oip.chain-transfer').find((p) => p.name === 'Layer former')!
    const rowFormer = byPkg(parts, 'oip.roller-conveyor').find((p) => p.name === 'Row former')!
    expect(chain.position[1]).toBeLessThan(rowFormer.position[1])
    expect(rowFormer.position[1] - chain.position[1]).toBeCloseTo(CELL.chainDropZ, 6)
    // and the 0.095 m pop-up stroke still lifts the row clear of the rollers
    expect(0.095 - CELL.chainDropZ).toBeGreaterThan(0.05)
    // The recess is not a demo-only correction: oip.chain-transfer declares the same offset as
    // snap.track.targetLocalY, so a transfer dragged onto a roller bed seats exactly where this cell places one
    // by hand. The two are pinned together in bundledPackageData.test.ts (which may import the baked packages -
    // this file may not, see the bundledExamples HMR boundary).
  })

  // The cell is authored to be reproducible by the snap: its lane spacing is a whole number of roller pitches,
  // which keeps every chain lane in a roller gap instead of riding a roller. The snap
  // rounds an authored spacing to whole pitches (core/snap/snapTrack adoptedLaneSpacing), so a demo value that
  // already is one survives a re-snap untouched - and a hand-tuned value that isn'T would silently shift when
  // anyone nudges the part.
  it('the transfer\'s lane spacing is a whole number of roller pitches (a re-snap would not move it)', () => {
    const parts = createPlcDemoScene().parts
    const distance = Number(paramsOf(byPkg(parts, 'oip.chain-transfer').find((p) => p.name === 'Layer former')!)['distance'])
    const multiple = distance / ROLLER_CLASSES.light.pitch
    expect(multiple).toBeCloseTo(Math.round(multiple), 6)
    expect(Math.round(multiple)).toBeGreaterThanOrEqual(1)
  })

  // The row-complete beam has to reach the forming lane and stop short of the row already pushed aside. It is the
  // mirrored course that binds: its parked row is the 0.6 m turned one, 0.2 m nearer than a canonical course's.
  // Overshoot it and the beam never reads false again, the case count alone declares the row done - and since
  // cases are counted at release, metres upstream, the arm ends up lifting a part-built layer.
  it('aims the row-complete beam past the forming lane but short of the parked row', () => {
    const parts = createPlcDemoScene().parts
    const eye = byPkg(parts, 'oip.diffuse-sensor').find((p) => p.name === 'Row complete')!
    const reach = eye.position[2] + (paramsOf(eye).maxRange as number)
    const laneNearEdge = CELL.laneZ - 0.2 // a straight case standing in the lane
    const parkedNearEdge = CELL.layerStopZ - 0.6 // the mirrored course parks its 0.6 m turned row here
    expect(reach).toBeGreaterThan(laneNearEdge)
    expect(reach).toBeLessThan(parkedNearEdge)
  })

  // The pallet line's frame-mounted eyes beam a few cm over the deck, so what they see is the pallet: the beam has to
  // run inside a pallet standing on that deck, and across the whole bed. Both hold by construction (the eye seats off
  // the deck the pallet rests on), and this is what keeps them that way through a retune of the deck, the rollers or
  // the pallet, rather than the lane eye going blind with nothing to say so.
  it('beams the frame-mounted pallet-line eyes through a pallet standing on their own deck', () => {
    const parts = createPlcDemoScene().parts
    // the photo-eye package (examples/parts/diffuse-sensor): its lens (the beam's origin) 0.1 m above its base
    const EYE_LENS_H = 0.1
    const eyes = byPkg(parts, 'oip.diffuse-sensor')
    for (const [eyeName, bedName] of [['Lane staged', 'Staging lane'], ['Load off deck', 'Outfeed conveyor']] as const) {
      const eye = eyes.find((p) => p.name === eyeName)!
      const bed = byPkg(parts, 'oip.roller-conveyor').find((p) => p.name === bedName)!
      expect(eye, eyeName).toBeDefined()
      expect(bed, bedName).toBeDefined()
      const over = eye.position[1]! + EYE_LENS_H - bed.position[1]!
      expect(over, `${eyeName} beam over the deck`).toBeGreaterThan(0.02)
      expect(over, `${eyeName} beam under the pallet's top`).toBeLessThan(PALLET_SIZE[1] - 0.02)
      // beside the bed, looking across it, and reaching its far edge
      const l = toLocalXZ(bed, eye.position[0]!, eye.position[2]!)
      const halfW = (paramsOf(bed).width as number) / 2
      expect(Math.abs(l.z), `${eyeName} beside the bed`).toBeGreaterThan(halfW)
      expect(Math.abs(Math.sin(eye.rotationY - bed.rotationY)), `${eyeName} looks across the bed`).toBeLessThan(1e-9)
      expect(paramsOf(eye).maxRange as number, `${eyeName} reaches the far edge`).toBeGreaterThan(Math.abs(l.z) + halfW - 0.05)
    }
  })

  // The squaring surface is the row former's own +z side guard, so the bed's size is constrained: its guard face
  // has to sit exactly at the layer's far face, while its -z rail stays flush with the infeed's. Those two
  // constraints fix the bed's width and centreline, so this test catches a resize of the bed that silently moves
  // the surface every layer is squared against.
  it('squares the layer on the row former\'s guard face, and keeps the far rail flush with the infeed', () => {
    const beds = byPkg(createPlcDemoScene().parts, 'oip.roller-conveyor')
    const infeed = beds.find((p) => p.name === 'Infeed')!
    const rowFormer = beds.find((p) => p.name === 'Row former')!
    // the guard has to be UP to be a stop at all
    expect(paramsOf(rowFormer).rightGuard).toBe(true)
    expect(paramsOf(rowFormer).leftGuard).toBe(true) // the -z one is the turning datum
    // its inner face - the roller rig seats a guard at width/2 + 0.0125, 0.005 thick - IS the layer stop
    const guardFace = rowFormer.position[2]! + (paramsOf(rowFormer).width as number) / 2 + CELL.guardInset
    expect(guardFace).toBeCloseTo(CELL.layerStopZ, 9)
    // The two beds are identical across the line - same width, same centreline - so the seam between them has no
    // step at all. They are two conveyors only because they are driven separately (the row former stops while the
    // arm lifts the layer off it, the infeed keeps feeding); nothing ever needed them to be different sizes, and
    // while they were, the far rail had a 78 mm step in it exactly where cases are being turned against it.
    expect(paramsOf(infeed).width).toBe(paramsOf(rowFormer).width)
    expect(infeed.position[2]).toBe(rowFormer.position[2])
  })

  // Across the line the bank is seated the way its own snap would seat it - lanes on a two-roller-pitch parity,
  // enough of them to span a whole row end to end. A bank sized loosely to the row leaves the trailing case half
  // off the last lane, and the push abandons it.
  //
  // Along the push it is seated exactly as its own snap would seat it: centred on the host bed and fitted to the
  // host's width (snap.track.fitWidthScale = 1). That equality is the point - author the cell any other way and
  // the part visibly jumps the first time anyone nudges it, because the snap corrects it back.
  it('seats the chain bank on lane parity, centred on the bed and reaching the guard', () => {
    const parts = createPlcDemoScene().parts
    const chain = byPkg(parts, 'oip.chain-transfer').find((p) => p.name === 'Layer former')!
    const rowFormer = byPkg(parts, 'oip.roller-conveyor').find((p) => p.name === 'Row former')!
    const prm = paramsOf(chain)
    const pitch = prm.distance as number
    // lanes land in roller gaps: the pitch is a whole multiple of the bed's 0.075 m roller spacing
    expect((pitch / 0.075) % 1).toBeCloseTo(0, 9)
    // and the bank spans a full 1.2 m row, reaching both of its ends
    expect((prm.chains as number) * pitch).toBeCloseTo(1.2, 9)

    expect(chain.position[2]).toBe(rowFormer.position[2]) // centred on the bed, as a snap would leave it
    const half = (prm.laneLength as number) / 2
    const deckFar = chain.position[2]! + half
    const deckNear = chain.position[2]! - half
    expect(deckFar).toBeCloseTo(CELL.layerStopZ - CELL.guardInset, 9) // reaches the guard, bar its own inset
    expect(deckNear).toBeLessThanOrEqual(CELL.laneZ - 0.3 - CELL.plowDriftZ + 1e-9) // gets under a drifted turned row
    // the host bed's width - what snap.track fits it to, so a re-snap is a no-op
    expect(prm.laneLength as number).toBeCloseTo(paramsOf(rowFormer).width as number, 9)
    // recessed below the roller line so the pop-up has something to lift out of
    expect(rowFormer.position[1]! - chain.position[1]!).toBeCloseTo(CELL.chainDropZ, 9)
  })

  // The boundary must go around the hazard, not between the arm and the conveyor it picks from. Nothing else
  // ties the fence to the arm, so this is what catches them drifting apart.
  it('encloses the arm, the pallet station and the layer it picks from inside one cell boundary', () => {
    const parts = createPlcDemoScene().parts
    const arm = byPkg(parts, 'oip.six-axis-robot')[0]!
    const pallet = parts.find((p) => p.name === 'Build pallet')!
    const zone = parts.find((p) => p.name === 'Cell zone')!
    const zp = paramsOf(zone)
    const xMin = zone.position[0]! - (zp.length as number) / 2
    const xMax = zone.position[0]! + (zp.length as number) / 2
    const zMin = zone.position[2]! - (zp.width as number) / 2
    const zMax = zone.position[2]! + (zp.width as number) / 2
    const inside = (x: number, z: number) => x > xMin && x < xMax && z > zMin && z < zMax
    expect(inside(arm.position[0]!, arm.position[2]!)).toBe(true)
    expect(inside(pallet.position[0]!, pallet.position[2]!)).toBe(true)
    // and the layer's far face too, so the arm never reaches across the boundary to pick
    expect(inside(CELL.loadX, CELL.layerStopZ)).toBe(true)

    // the painted line and the steel agree: three fence runs on three edges of that same rectangle (the -x edge
    // is left open - it is the truck lane and the conveyor's way in)
    // sibling names are made unique on placement ("Cell fence", "Cell fence 2", ...), so match the stem
    const fences = byPkg(parts, 'oip.fence').filter((p) => p.name?.startsWith('Cell fence'))
    const south = fences.find((p) => p.rotationY === 0 && p.position[2]! > 0)!
    const north = fences.find((p) => p.rotationY === 0 && p.position[2]! < 0)!
    const east = eastRun(fences)
    expect(south.position[2]).toBeCloseTo(zMax, 9)
    expect(north.position[2]).toBeCloseTo(zMin, 9)
    expect(east.position[0]).toBeCloseTo(xMax, 9)
  })

  // ...and the boundary has to be outside the arm, not merely around it. The east run failed that for as long as
  // the south one did and survived the same fix, because nothing tied it to the arm either: at x 7.0 it stood
  // half a metre inside the swept envelope, so the counterweight behind the shoulder passed through the mesh on
  // every pick. ARM_REACH_X is measured (e2e/probes/arm-envelope.mjs) precisely because FK cannot say where the
  // back of a casting is - so this is the only thing that keeps a fence edit from walking back into it.
  it('puts the guarding outside the arm, not through it', () => {
    const parts = createPlcDemoScene().parts
    const east = eastRun(byPkg(parts, 'oip.fence').filter((p) => p.name?.startsWith('Cell fence')))
    expect(east.position[0]! - ARM_REACH_X).toBeGreaterThan(0.5)
    // the whole south side is closed, hinge to east corner: the gate leaf plus the runs either side of it span
    // it end to end (bar the two post-width reliefs that read as the gate frame), so widening the cell can't
    // leave a person-sized hole at the east end
    const southRuns = parts.filter((p) => p.name?.startsWith('Cell fence') && p.rotationY === 0 && p.position[2]! > 0)
    const gate = parts.find((p) => p.name === 'Cell gate')!
    const spans = [...southRuns, gate].map((p) => {
      const len = paramsOf(p).length as number
      return [p.position[0]! - len / 2, p.position[0]! + len / 2] as const
    }).sort((a, b) => a[0] - b[0])
    expect(spans[spans.length - 1]![1]).toBeCloseTo(east.position[0]!, 9) // closes on the east corner
    for (let i = 1; i < spans.length; i++) expect(spans[i]![0] - spans[i - 1]![1]).toBeLessThan(0.2)
  })

  // ...and the guard line has to cross the case line upstream of everything the arm reaches, which is a different
  // question from whether the crossing itself is watertight and was wrong long after that one was fixed.
  //
  // The crossing was the row former's discharge end - the end the line delivers from, which sounds like where a
  // cell takes its infeed and is the wrong end of the bed. The arm picks the layer OFF that bed with a plate the
  // size of the layer, reaching to ARM_REACH_WEST_X, so the whole pick station stood outside the steel: the plate
  // came down 15 mm from the bed's near rail, and that rail is the operator's own floor. A boundary can be
  // watertight in the wrong place, and this is what says it is in the right one.
  it('crosses the case line upstream of everything the arm reaches', () => {
    const parts = createPlcDemoScene().parts
    const cell = byPkg(parts, 'oip.fence').filter((p) => p.name?.startsWith('Cell fence'))
    const rowFormer = byPkg(parts, 'oip.roller-conveyor').find((p) => p.name === 'Row former')!
    // the crossing is the west end of the south run
    const southRun = cell.filter((p) => p.rotationY === 0 && p.position[2]! > 0)
      .sort((a, b) => a.position[0]! - b.position[0]!)[0]!
    const crossingX = southRun.position[0]! - (paramsOf(southRun).length as number) / 2
    // the plate comes down on the layer at ARM_REACH_WEST_X; a crossing east of that leaves the pick outside
    expect(ARM_REACH_WEST_X - crossingX).toBeGreaterThan(0.5)
    // and upstream of the whole bed the layer is built on, not merely of one pose
    expect(crossingX).toBeLessThanOrEqual(rowFormer.position[0]! - (paramsOf(rowFormer).length as number) / 2)
  })

  // The perimeter, walked: all four sides, since a spec that measures only the crossings someone thought about
  // passes while a whole side is open.
  //
  // A barrier is the steel (fence runs and the closed gate) plus a conveyor bed where its own footprint actually
  // is - a bed closes a boundary only where it stands, which is what makes the two conveyor crossings legitimate
  // and a bare gap not.
  it('closes the cell boundary on every side - the gate and two conveyors are the only ways through', () => {
    const SHOULDER = 0.35 //   a person turned sideways; below this a gap is a reveal, not a door
    const FENCE_CAP_HALF = 0.0324 //  a run reaches its end post's cap
    const FRAME_PROUD = 0.03 //       ...and a bed reaches its L-rail's flange lip
    const parts = createPlcDemoScene().parts
    const zone = parts.find((p) => p.name === 'Cell zone')!
    const zp = paramsOf(zone)
    const x0 = zone.position[0]! - (zp.length as number) / 2, x1 = zone.position[0]! + (zp.length as number) / 2
    const z0 = zone.position[2]! - (zp.width as number) / 2, z1 = zone.position[2]! + (zp.width as number) / 2

    /** every barrier's world footprint: fences/gate by their run + caps, conveyor beds by their deck + frame */
    const boxes = parts.flatMap((p) => {
      const q = paramsOf(p), id = pkgId(p)
      const fence = id === 'oip.fence' || id === 'oip.safety-gate'
      if (!fence && id !== 'oip.roller-conveyor') return []
      const half = (q.length as number) / 2
      const [lx0, lx1] = fence
        ? [-half - (q.omitPostStart === true ? 0 : FENCE_CAP_HALF), half + (q.omitPostEnd === true ? 0 : FENCE_CAP_HALF)]
        : [-half, half]
      const lz = fence ? FENCE_CAP_HALF : (q.width as number) / 2 + FRAME_PROUD
      const xs: number[] = [], zs: number[] = []
      for (const lx of [lx0, lx1]) for (const l of [-lz, lz]) {
        const w = toWorldXZ(p, lx, l)
        xs.push(w.x); zs.push(w.z)
      }
      return [{ x0: Math.min(...xs), x1: Math.max(...xs), z0: Math.min(...zs), z1: Math.max(...zs) }]
    })

    /** walk one edge of the rectangle from `from` to `to`, over every barrier that stands ON that edge line */
    const walk = (name: string, from: number, to: number, spans: (readonly [number, number])[]) => {
      let at = from
      // only what stands along this edge: a barrier elsewhere on the same line (the staging bay's knee-rail crosses the
      // west edge's line 4 m south of the cell) closes nothing here
      for (const [a, b] of spans.filter(([a, b]) => b > from && a < to).sort((p, q) => p[0] - q[0])) {
        expect(a - at, `${name} edge: ${(a - at).toFixed(3)} m clear before ${a.toFixed(3)}`).toBeLessThan(SHOULDER)
        at = Math.max(at, b)
      }
      expect(to - at, `${name} edge: ${(to - at).toFixed(3)} m clear at its far end`).toBeLessThan(SHOULDER)
    }
    // a barrier stands on a Z-edge if its footprint contains that z (inclusive - two beds butted ON the line
    // still block it), and it then blocks that edge over its own x extent. Same the other way for an X-edge.
    const onZ = (z: number) => boxes.filter((b) => b.z0 <= z && z <= b.z1).map((b) => [b.x0, b.x1] as const)
    const onX = (x: number) => boxes.filter((b) => b.x0 <= x && x <= b.x1).map((b) => [b.z0, b.z1] as const)
    walk('south', x0, x1, onZ(z1))
    walk('north', x0, x1, onZ(z0))
    walk('west', z0, z1, onX(x0))
    walk('east', z0, z1, onX(x1))
  })

  // ...and fencing the -x side is only legitimate because nothing drives through it any more. The trucks once
  // served the palletizer directly; they now work the staging lanes and the racks, so the cell can be closed.
  // If a route is ever put back through the cell, this fails rather than a truck driving into a fence.
  it('keeps both truck routes outside the guarded cell', () => {
    const parts = createPlcDemoScene().parts
    const zone = parts.find((p) => p.name === 'Cell zone')!
    const zp = paramsOf(zone)
    const hx = (zp.length as number) / 2, hz = (zp.width as number) / 2
    for (const [truck, rows] of Object.entries({ rack: RACK_ROUTE, supply: SUPPLY_ROUTE })) {
      for (const [i, row] of rows.entries()) {
        const [x, z] = row as unknown as number[]
        const inside = Math.abs(x! - zone.position[0]!) < hx && Math.abs(z! - zone.position[2]!) < hz
        expect(inside, `truck ${truck} route row ${i} stands at (${x}, ${z}), inside the cell`).toBe(false)
      }
    }
  })

  // ...and outside the conveyors as well, which is a different measurement and was wrong for as long as the arm one
  // was. Neither part ends where its parameters say: the SDK fence draws a 0.06 m post centred ON each run end
  // (examples/parts/fence/part.js), and a roller bed's L-rail lip reaches 0.03 past its deck edge
  // (examples/parts/roller-conveyor/rig.json), so two runs spaced off `length/2` and `width/2` overlap by up to
  // 0.06 while both look correct in the numbers. That is exactly how the north run's end post came to stand 34 mm
  // inside the pallet outfeed's east frame, floor to cap, threaded through the rail and the leg trestle: every
  // existing spec here measured deck edges, which cleared by 25 mm.
  //
  // Footprint-only is the whole test - a fence runs from the floor up and a bed's legs run down to it, so anything
  // that overlaps in plan overlaps in space.
  it('keeps the guarding clear of the conveyors too - posts and frames, not deck edges', () => {
    const FENCE_CAP_HALF = 0.0324 // POST/2 x 1.08: the cap is the widest part of an end post
    const FRAME_PROUD = 0.03 //      the L-rail's top flange lip, at width/2 + 0.03
    const parts = createPlcDemoScene().parts
    /** exact for a scene of axis-aligned parts (every run and bed here is at rotY 0 or +/-90) */
    const aabb = (p: PartInstance, lx0: number, lx1: number, lz0: number, lz1: number) => {
      const xs: number[] = [], zs: number[] = []
      for (const lx of [lx0, lx1]) for (const lz of [lz0, lz1]) {
        const w = toWorldXZ(p, lx, lz)
        xs.push(w.x); zs.push(w.z)
      }
      return { x0: Math.min(...xs), x1: Math.max(...xs), z0: Math.min(...zs), z1: Math.max(...zs) }
    }
    const barriers = parts.filter((p) => pkgId(p) === 'oip.fence' || pkgId(p) === 'oip.safety-gate')
    const beds = byPkg(parts, 'oip.roller-conveyor')
    expect(barriers.length).toBeGreaterThanOrEqual(6) // the cell runs + the gate
    expect(beds.length).toBeGreaterThanOrEqual(6)
    const clashes: string[] = []
    for (const b of barriers) {
      const bp = paramsOf(b)
      const half = (bp.length as number) / 2
      // a run reaches its end post's cap, unless that post is given up to a neighbour (omitPost*)
      const bb = aabb(b, -half - (bp.omitPostStart === true ? 0 : FENCE_CAP_HALF),
        half + (bp.omitPostEnd === true ? 0 : FENCE_CAP_HALF), -FENCE_CAP_HALF, FENCE_CAP_HALF)
      for (const c of beds) {
        const cp = paramsOf(c)
        const cw = (cp.width as number) / 2 + FRAME_PROUD
        const cb = aabb(c, -(cp.length as number) / 2, (cp.length as number) / 2, -cw, cw)
        const dx = Math.min(bb.x1, cb.x1) - Math.max(bb.x0, cb.x0)
        const dz = Math.min(bb.z1, cb.z1) - Math.max(bb.z0, cb.z0)
        if (dx > 0 && dz > 0) clashes.push(`${b.name} through ${c.name} by ${Math.max(dx, dz).toFixed(4)} m`)
      }
    }
    expect(clashes).toEqual([])

    // and the seam that has to be tight stays a reveal rather than becoming a standoff: the north run's end post is
    // what closes the boundary down to the outfeed, so it belongs beside the bed's steel, just not in it
    const north = barriers.filter((p) => p.name?.startsWith('Cell fence')).find((p) => p.rotationY === 0 && p.position[2]! < 0)!
    const outfeed = beds.find((p) => p.name === 'Outfeed conveyor')!
    const postFace = north.position[0]! - (paramsOf(north).length as number) / 2 - FENCE_CAP_HALF
    const bedSteel = outfeed.position[0]! + (paramsOf(outfeed).width as number) / 2 + FRAME_PROUD
    expect(postFace - bedSteel).toBeGreaterThan(0.04)
    expect(postFace - bedSteel).toBeLessThan(0.2)
  })

  // The light curtains. Each conveyor opening is closed below its deck by the bed and above it only by a curtain, so
  // this pins what makes one guard that column of air without stopping the line for its own product: it spans the
  // bed's steel, it stands clear of the bed (leg trestles included) and of the fence it sits beside, its lowest beam
  // is low enough that every load breaks it (which is what makes muting necessary rather than decoration), its
  // muting sensors are spaced so the load mutes it all the way through, and it mutes only the way the bed conveys.
  it('guards each conveyor opening with a muted light curtain that spans its bed and stands clear of it', () => {
    const parts = createPlcDemoScene().parts
    const curtains = byPkg(parts, 'oip.light-curtain')
    expect(curtains.map((c) => paramsOf(c).tag).sort()).toEqual(['CaseCurtain', 'FeedCurtain', 'OutCurtain'])
    const beds = byPkg(parts, 'oip.roller-conveyor')
    const fences = byPkg(parts, 'oip.fence')
    // the curtain package's column (examples/parts/light-curtain): a 0.036 m profile on a 0.09 x 0.11 plate set 0.02 out
    const COLUMN_HALF = 0.018, PLATE_OUT = 0.02, PLATE_HALF_X = 0.045, PLATE_HALF_Z = 0.055
    // a leg reaches furthest past the deck edge at its frame clamp's bolt: overhang + clamp offset + clamp + bolt
    // (LEG_REACH_OVER_HW in render/parts/common.ts); its foot plate, 0.46 m along the bed, stops well inside that
    const FRAME_PROUD = 0.03, LEG_OVER_HW = 0.003 + 0.023 + 0.022 + 0.011, LEG_FOOT_HALF = 0.23, FENCE_PLATE_HALF = 0.06
    const CASE_SHORT_SIDE = 0.4, PALLET_SHORT_SIDE = 1.02, PERSON_DEPTH = 0.6
    // the photo-eye package (examples/parts/diffuse-sensor): its lens (the beam's origin) 0.1 m above its base
    const EYE_LENS_H = 0.1
    const eyes = byPkg(parts, 'oip.diffuse-sensor')
    for (const c of curtains) {
      const cp = paramsOf(c)
      const w = cp.width as number
      const bed = beds.find((b) => {
        const l = toLocalXZ(b, c.position[0]!, c.position[2]!)
        return Math.abs(l.x) < (paramsOf(b).length as number) / 2 && Math.abs(l.z) < 0.05
      })
      expect(bed, `${c.name} stands over a bed's centreline`).toBeDefined()
      const bp = paramsOf(bed!)
      const halfW = (bp.width as number) / 2
      // square to the bed: the curtain's travel axis (its local Z) is the bed's (its local X)
      expect(Math.abs(Math.sin(c.rotationY - bed!.rotationY)), c.name).toBeCloseTo(1, 9)
      // the beams span the steel, and the columns' plates stand clear of it; where a leg station's foot plate reaches
      // the curtain's line they clear the trestle too
      const plateInner = w / 2 + COLUMN_HALF + PLATE_OUT - PLATE_HALF_X
      expect(plateInner - (halfW + FRAME_PROUD), `${c.name} plate to bed steel`).toBeGreaterThan(0.02)
      const along = toLocalXZ(bed!, c.position[0]!, c.position[2]!).x
      const len = bp.length as number
      for (const s of legStations(len, -len / 2)) {
        if (Math.abs(s - along) < LEG_FOOT_HALF + PLATE_HALF_Z) {
          expect(plateInner - (halfW + LEG_OVER_HW), `${c.name} plate to ${bed!.name} leg at ${s.toFixed(2)}`).toBeGreaterThan(0.01)
        }
      }
      // each column stands in line with one of the opening's fence end posts, set back off the fence line far enough
      // that the two floor plates do not meet
      for (const side of [-1, 1]) {
        const colX = side * (w / 2 + COLUMN_HALF)
        let best: { dx: number; dz: number } | null = null
        for (const f of fences) {
          const fp = paramsOf(f)
          const half = (fp.length as number) / 2
          for (const [end, omitted] of [[-half, fp.omitPostStart === true], [half, fp.omitPostEnd === true]] as const) {
            if (omitted) continue
            const wp = toWorldXZ(f, end, 0)
            const l = toLocalXZ(c, wp.x, wp.z)
            const d = { dx: Math.abs(l.x - colX), dz: Math.abs(l.z) }
            if (!best || Math.hypot(d.dx, d.dz) < Math.hypot(best.dx, best.dz)) best = d
          }
        }
        expect(best!.dx, `${c.name} column ${side} in line with a fence end post`).toBeLessThan(0.005)
        expect(best!.dz, `${c.name} column ${side} plate clear of the post's`).toBeGreaterThan(FENCE_PLATE_HALF + PLATE_HALF_Z)
        expect(best!.dz, `${c.name} column ${side} set back no further than it has to be`).toBeLessThan(0.2)
      }
      // the lowest beam sits over the deck, under the top of the lowest load (a pallet, 0.135 m): every load breaks it
      const deck = bp.standHeight as number
      const bottom = cp.fieldBottom as number
      expect(bottom - deck, c.name).toBeGreaterThan(0.05)
      expect(bottom - deck, c.name).toBeLessThan(0.135)
      // ...so muting carries the line: two photo-eyes, A1 then A2 before the curtain in the bed's travel, each on the
      // bed's side looking straight across it just above the rollers, and spaced for the shortest load that
      // passes (a case's 0.4 m side on the case line, a pallet's 1.02 on the others), which must block an outer and an
      // inner eye at once. On the pallet lines that gap is also wider than a person is deep, so walking in does not
      // mute them; on the case line it cannot be (a case is shorter than a person), which the scene owns up to.
      expect(bp.speed as number, `${bed!.name} conveys forward`).toBeGreaterThan(0)
      const prefix = (cp.tag as string).replace('Curtain', '')
      expect(cp.mutingLampTag, c.name).toBe(`${prefix}Muted`)
      // two eyes, both before the curtain in travel (MutingSeq ends a muting by the curtain, so none stand after it)
      const pins = ['A1', 'A2']
      expect(eyes.filter((e) => String(paramsOf(e).tag).startsWith(`${prefix}Mute`)).length, `${c.name} muting eyes`).toBe(pins.length)
      const at: Record<string, number> = {}
      for (const pin of pins) {
        const eye = eyes.find((e) => paramsOf(e).tag === `${prefix}Mute${pin}`)
        expect(eye, `${c.name} muting eye ${pin}`).toBeDefined()
        const l = toLocalXZ(bed!, eye!.position[0]!, eye!.position[2]!)
        at[pin] = l.x - along
        expect(Math.abs(l.z), `${eye!.name} beside the bed`).toBeGreaterThan(halfW)
        // its beam (local +Z) square to the bed's travel (its local +X), and pointing IN across the deck
        expect(Math.abs(Math.sin(eye!.rotationY - bed!.rotationY)), `${eye!.name} looks across the bed`).toBeLessThan(1e-9)
        const lensToCentre = toLocalXZ(bed!, eye!.position[0]! + Math.sin(eye!.rotationY), eye!.position[2]! + Math.cos(eye!.rotationY)).z
        expect(Math.abs(lensToCentre), `${eye!.name} looks toward the bed, not away`).toBeLessThan(Math.abs(l.z))
        expect(paramsOf(eye!).maxRange as number, `${eye!.name} reaches the far side`).toBeGreaterThan(2 * halfW)
        const lens = eye!.position[1]! + EYE_LENS_H
        expect(lens - deck, `${eye!.name} lens over the rollers`).toBeGreaterThan(0.03)
        expect(lens, `${eye!.name} lens under the lowest beam`).toBeLessThan(bottom)
      }
      expect(at['A1']! < at['A2']! && at['A2']! < 0, `${c.name} eyes before the curtain, outer first`).toBe(true)
      const load = cp.tag === 'CaseCurtain' ? CASE_SHORT_SIDE : PALLET_SHORT_SIDE
      for (const gap of [at['A2']! - at['A1']!]) {
        expect(load - gap, `${c.name} outer-to-inner gap under the load`).toBeGreaterThan(0.05)
        if (cp.tag === 'CaseCurtain') expect(gap, `${c.name} gap (a person can mute it: the scene's known flaw)`).toBeLessThan(PERSON_DEPTH)
        else expect(gap, `${c.name} gap wider than a person`).toBeGreaterThan(PERSON_DEPTH)
      }
    }
  })

  // A curtain that trips drops the run, not just the permit: the line stays down until someone presses Start, which
  // is the manual reset a passable opening needs. The gate is the same: closing a guard must not start the cell.
  it('stops the line on a tripped curtain until Start is pressed', () => {
    const { p, step } = runner()
    step({}, 5)
    expect(p.get('running')).toBe(true)
    step({ OutCurtain: false }, 1)
    expect(p.get('running')).toBe(false)
    expect(p.get('Tower')).toBe(0) // dark: a trip is not an E-stop, so not red
    step({ OutCurtain: true }, 5) // clear again: still stopped
    expect(p.get('running')).toBe(false)
    step({ Start: true }, 1)
    step({ Start: false }, 1)
    expect(p.get('running')).toBe(true)
  })

  // The rack line is not dressing (the trucks put loads away in it), and it is not free-standing either - it is
  // spaced off the cell, so it can never crowd the fence, the arm's envelope or the cell's painted border.
  it('leaves a real aisle between the cell fence and the rack line', () => {
    const parts = createPlcDemoScene().parts
    const east = eastRun(byPkg(parts, 'oip.fence').filter((p) => p.name?.startsWith('Cell fence')))
    const racks = byPkg(parts, 'oip.rack')
    expect(racks.length).toBe(3)
    for (const r of racks) {
      // a rack's footprint is its length plus the half-thickness of the 0.08 end uprights on each end line
      const west = r.position[0]! - ((paramsOf(r).length as number) / 2 + 0.04)
      expect(west - east.position[0]!).toBeGreaterThan(2.5)
    }
    // and the painted zones stop short of each other too - one edge each, not two overlapping ones
    const cellZone = parts.find((p) => p.name === 'Cell zone')!
    const storeZone = parts.find((p) => p.name === 'Storage zone')!
    const cellEast = cellZone.position[0]! + (paramsOf(cellZone).length as number) / 2
    const storeWest = storeZone.position[0]! - (paramsOf(storeZone).length as number) / 2
    expect(storeWest).toBeGreaterThan(cellEast)
  })

  // The idle pose must NOT be one of the apexes. An apex is a via point, held to a loose tool-down tolerance
  // because the arm only sweeps through it - park there and the plate stands visibly off level. The idle pose is
  // solved separately, to the strict tolerance, squared between the two stations.
  it('idles on a pose of its own, square between the stations, not on a via apex', () => {
    for (const w of PALLETIZER.waypoints) expect(PALLETIZER.home).not.toEqual(w.pose)
    // squared on the base's own centreline: mid-swing, so a cycle opens by turning to one station or the other
    expect(Math.abs(PALLETIZER.home[0]!)).toBeLessThan(5)
    const pickSwing = PALLETIZER.waypoints[0]!.pose[0]!
    const placeSwing = PALLETIZER.waypoints[2]!.pose[0]!
    expect(pickSwing).toBeGreaterThan(PALLETIZER.home[0]!)
    expect(placeSwing).toBeLessThan(PALLETIZER.home[0]!)
  })

  // The riser is an input to the pose set, not dressing under it: all seven trained poses were solved with the
  // shoulder exactly pedestalHeight off the floor (it gives j5 enough pitch travel to hold the plate flat
  // over the top course; see PALLETIZER.robotPosition). So two things have to hold, and nothing else pins them.
  //
  // First, the part holding the arm up has to put it exactly there. Second - and this is why the riser is an
  // oip.shape and not the oip.platform used as a stand elsewhere in this scene - its height has to be an
  // authored number. A platform's height carries `rest: 'surfaceBelow'`: the origin is the deck top and the host
  // re-resolves the height from whatever is under it at every drop, snap and translate. That is right for a deck
  // people stand on and wrong for a dimension seven joint solutions are pinned to, because it can move without
  // anyone touching the poses. On a flat floor it would resolve to the same number today; the point is that it
  // is host-managed and this is not.
  it('stands the arm on a riser whose top face is exactly where the poses were solved', () => {
    const scene = createPlcDemoScene()
    const arm = byPkg(scene.parts, 'oip.six-axis-robot')[0]!
    const riser = scene.parts.find((p) => p.name === 'Palletizer pedestal')!
    const rp = paramsOf(riser)
    expect(arm.position[1]).toBeCloseTo(PALLETIZER.pedestalHeight, 9)
    // top face = origin + height (an oip.shape grows from its own y), and that IS the arm's base plane
    expect((riser.position[1] ?? 0) + (rp.height as number)).toBeCloseTo(arm.position[1]!, 9)
    // and it stands under the arm, not beside it
    expect(riser.position[0]).toBeCloseTo(arm.position[0]!, 9)
    expect(riser.position[2]).toBeCloseTo(arm.position[2]!, 9)

    // the height is authored, not re-derived by the host from the surface below. Assert the param exists
    // first: `?.rest` on a renamed param is undefined too, which would pass for the wrong reason.
    const pkg = (scene.packages ?? []).find((k) => k.id === pkgId(riser))!
    expect(pkg.params['height']).toBeDefined()
    expect(pkg.params['height']?.rest).toBeUndefined()
  })

  // The test for "is it seated?": ask the snap. Everything else here reasons about the snap contract from the
  // outside and can drift from what the code actually does - this drops the authored part back onto its own bed
  // and asserts the snap has nothing to change. If it moves or resizes it, the part visibly jumps the first time
  // anyone nudges it in the editor, which is exactly how this was found.
  it('the chain transfer is already where its own snap would put it - a re-snap is a no-op', () => {
    const scene = createPlcDemoScene()
    for (const pkg of scene.packages ?? []) registerPackage(pkg)
    const chain = byPkg(scene.parts, 'oip.chain-transfer').find((p) => p.name === 'Layer former')!
    const snapped = findSnap(chain, { position: chain.position, rotationY: chain.rotationY }, scene.parts)
    expect(snapped).not.toBeNull()
    // it seats onto the row former, not onto some other bed
    expect(scene.parts.find((q) => q.id === snapped!.targetId)?.name).toBe('Row former')
    // ...and it is already there: no move, no re-size
    for (const axis of [0, 1, 2]) expect(snapped!.pose.position[axis]).toBeCloseTo(chain.position[axis]!, 6)
    for (const [k, v] of Object.entries(snapped!.paramOverrides ?? {})) {
      expect(`${k}=${v}`).toBe(`${k}=${(chain.params as Record<string, unknown>)[k]}`)
    }
  })

  // Same test, one seam over: the turntable's plate is round and 1.5x its deck width, so its end is the rim, not
  // half the deck. Butt the outfeed and the two staging lanes at width/2 (which reads right, and is what this
  // scene did) and each one parks 0.4 m inside the disc with its rollers buried in the plate.
  it('the outfeed and the staging lane butt the turntable plate, not its deck square', () => {
    const scene = createPlcDemoScene()
    for (const pkg of scene.packages ?? []) registerPackage(pkg)
    const named = (n: string): PartInstance => scene.parts.find((p) => p.name === n && p.type === 'part')!
    const turntable = named('Outfeed turntable')
    const rim = conveyorEndsOf(turntable)
    // the plate radius the part actually draws: width x plateFactor/2 (rig.json's plateFactor is 1.5)
    const radius = ((paramsOf(turntable).width as number) * 1.5) / 2
    expect(radius).toBeCloseTo(1.2, 9)
    for (const e of rim) expect(Math.hypot(e.x - turntable.position[0]!, e.z - turntable.position[2]!)).toBeCloseTo(radius, 9)

    // each neighbour's nearest end lands ON that rim - the outfeed that mates end-to-end and the lane that
    // side-merges onto the flank, which the snap seats on the rim as well
    for (const name of ['Outfeed conveyor', 'Staging lane']) {
      const lane = named(name)
      const reach = Math.min(...conveyorEndsOf(lane).map((e) => Math.hypot(e.x - turntable.position[0]!, e.z - turntable.position[2]!)))
      expect(`${name} end at ${reach.toFixed(4)} from the deck centre`).toBe(`${name} end at ${radius.toFixed(4)} from the deck centre`)
    }

    // ...and the snap agrees: dropped where it stands, the lane is already seated on the turntable
    for (const name of ['Staging lane']) {
      const lane = named(name)
      const snapped = findSnap(lane, { position: lane.position, rotationY: lane.rotationY }, scene.parts)
      expect(`${name} -> ${scene.parts.find((q) => q.id === snapped?.targetId)?.name}`).toBe(`${name} -> Outfeed turntable`)
      for (const axis of [0, 1, 2]) expect(snapped!.pose.position[axis]).toBeCloseTo(lane.position[axis]!, 6)
    }
  })

  // The gallery stair's connection to its platform. This is worth pinning because it fails silently and totally:
  // nothing throws, no gate goes red, the flight still renders - it stops being connected, and then the
  // platform keeps its railing closed across the head of the flight (and that railing carries the only collidable
  // link in the assembly, so the deck becomes unreachable), carves a notch out of its own deck where the landing
  // overlaps it, and leaves the flight unlifted below the deck plane. The trap is that the seat is the run plus
  // the top landing: placed a bare run back from the edge, as this scene was, the seat lands 0.59 m inside the
  // deck - six times CONTACT_TOLERANCE - and the connection is never made.
  it('seats the gallery stair on the deck edge, so the platform opens its railing and takes no deck notch', () => {
    const scene = createPlcDemoScene()
    for (const pkg of scene.packages ?? []) registerPackage(pkg)
    const named = (n: string): PartInstance => scene.parts.find((p) => p.name === n && p.type === 'part')!
    const deck = named('Gallery deck')
    const stair = named('Gallery stair')
    const steps = paramsOf(stair).numSteps as number
    const width = paramsOf(stair).width as number

    // the seat - the top of the run, where the deck takes over as the landing - lands ON the deck's west edge
    const deckWestX = deck.position[0]! - (paramsOf(deck).length as number) / 2
    const seatX = stair.position[0]! + steps * STAIRS_STANDARD_TREAD
    expect(seatX).toBeCloseTo(deckWestX, 9)

    const conn = computeStructureConnections(scene.parts)
    // the railing opens over the flight's width...
    expect(conn.platform.get(deck.id)?.openings.negX).toEqual([[-width / 2, width / 2]])
    // ...no hole is cut in the deck (an edge-flush seat only nicks the rim)...
    expect(conn.platform.get(deck.id)?.notches).toEqual([])
    // ...and the flight's top walking surface meets the deck. The deck stands at a whole number of risers, so the
    // connection lifts only structureConnections' LANDING_CLEARANCE, which keeps the two walking surfaces off one
    // plane: the top ends slightly proud, never below the deck.
    const lift = conn.stairTopConnected.get(stair.id)
    expect(lift).toBeDefined()
    const topY = stair.position[1]! + steps * STAIRS_STANDARD_RISE + lift!
    expect(topY).toBeGreaterThan(deck.position[1]!)
    expect(topY - deck.position[1]!).toBeLessThanOrEqual(0.002)

    // the east flight the same way, turned half round onto the deck's east edge
    const east = named('Gallery east stair')
    expect(east.rotationY).toBeCloseTo(Math.PI, 9)
    const deckEastX = deck.position[0]! + (paramsOf(deck).length as number) / 2
    expect(east.position[0]! - (paramsOf(east).numSteps as number) * STAIRS_STANDARD_TREAD).toBeCloseTo(deckEastX, 9)
    expect(conn.platform.get(deck.id)?.openings.posX).toEqual([[-width / 2, width / 2]])
    const eastLift = conn.stairTopConnected.get(east.id)
    expect(eastLift).toBeDefined()
    const eastTop = east.position[1]! + (paramsOf(east).numSteps as number) * STAIRS_STANDARD_RISE + eastLift!
    expect(eastTop).toBeGreaterThan(deck.position[1]!)
    expect(eastTop - deck.position[1]!).toBeLessThanOrEqual(0.002)
    // ...and its foot lands on open floor, a metre clear of the exit leg rather than across it
    const exitLeg = scene.parts.find((p) => p.name === 'Walkway to exit')!
    const exitLegWestX = exitLeg.position[0]! - (paramsOf(exitLeg).length as number) / 2
    expect(exitLegWestX - east.position[0]!).toBeGreaterThanOrEqual(1.0 - 1e-9)

    // and the walkway's last leg lands ON the foot, so the paint leads to the flight instead of stopping beside it
    const walkways = scene.parts.filter((p) => p.name?.startsWith('Walkway') && pkgId(p) === 'oip.floor-marking')
    // the legs that run across the floor's z are the one down to the stair and the one to the exit door; the stair's is
    // the westmost
    const across = walkways.filter((w) => w.rotationY === 0 && paramsOf(w).style === 'stripes').sort((a, b) => a.position[0]! - b.position[0]!)
    expect(across).toHaveLength(2)
    const toStair = across.slice(0, 1)
    expect(toStair[0]!.position[0]! + (paramsOf(toStair[0]!).length as number) / 2).toBeCloseTo(stair.position[0]!, 9)
    // ...and it runs on past the flight's far flank, so the whole width of the stair opens off painted floor
    const legFarZ = toStair[0]!.position[2]! + (paramsOf(toStair[0]!).width as number) / 2
    expect(legFarZ).toBeGreaterThanOrEqual(stair.position[2]! + width / 2 - 1e-9)
  })

  // The gallery stands beside the walkway, not on it: its columns and the flight's north flank keep off the paint
  // people walk on. Its deck has to clear the cell fence's caps by more than eye height minus railing, or the view it
  // exists for is the top rail of the fence.
  it('keeps the gallery off the walkway, high enough to look over the cell fence', () => {
    const scene = createPlcDemoScene()
    const walk = scene.parts.find((p) => p.name === 'Walkway' && pkgId(p) === 'oip.floor-marking' && p.rotationY !== 0)!
    // the main leg is turned a quarter: its `length` runs across the floor's z
    const walkSouthZ = walk.position[2]! + (paramsOf(walk).length as number) / 2
    for (const n of ['Gallery deck', 'Gallery stair', 'Gallery east stair']) {
      const p = scene.parts.find((q) => q.name === n && q.type === 'part')!
      const northEdge = p.position[2]! - (paramsOf(p).width as number) / 2
      expect(northEdge - walkSouthZ, n).toBeGreaterThanOrEqual(0.5 - 1e-9)
    }
    const deck = scene.parts.find((q) => q.name === 'Gallery deck' && q.type === 'part')!
    expect(paramsOf(deck).height).toBeCloseTo(deck.position[1]!, 9) // the columns reach the floor
    const fenceTop = Math.max(...byPkg(scene.parts, 'oip.fence').map((f) => f.position[1]! + ((paramsOf(f).height as number) ?? 2)))
    expect(deck.position[1]! - fenceTop).toBeGreaterThanOrEqual(0.9)
  })

  // The walkway ends where forklift floor begins: a stop bar across its full width, butting the main leg, short of the
  // outbound staging's border by the same half metre the walkway kept before.
  it('ends the walkway at a stop bar short of the outbound staging', () => {
    const scene = createPlcDemoScene()
    const bar = scene.parts.find((p) => p.name === 'Walkway stop bar')!
    expect(paramsOf(bar).style).toBe('hazard')
    const main = scene.parts.find((w) => w.name?.startsWith('Walkway') && pkgId(w) === 'oip.floor-marking' && w.rotationY !== 0)!
    const mainEastX = main.position[0]! + (paramsOf(main).width as number) / 2
    const barWestX = bar.position[0]! - (paramsOf(bar).length as number) / 2
    const barEastX = bar.position[0]! + (paramsOf(bar).length as number) / 2
    expect(barWestX).toBeCloseTo(mainEastX, 9)
    expect(paramsOf(bar).width as number).toBeCloseTo(paramsOf(main).length as number, 9) // the walkway's full width
    expect(bar.position[2]).toBeCloseTo(main.position[2]!, 9)
    const staging = scene.parts.find((q) => q.name === 'Outbound staging zone')!
    const stagingWestX = staging.position[0]! - (paramsOf(staging).length as number) / 2
    expect(stagingWestX - barEastX).toBeCloseTo(0.5, 6)
  })

  // A building this size needs personnel exits along its walls. The demo's is on the people side of the floor, in the
  // open strip between the gallery and the outbound staging, and the walkway leads to it: a door no route reaches reads
  // as a wall feature rather than an exit.
  it('has a personnel exit door in the south wall, kept clear, with a walkway leg leading to it', () => {
    const scene = createPlcDemoScene()
    const shell = scene.parts.find((p) => p.type === 'building')! as Parameters<typeof personnelDoors>[0]
    const doors = personnelDoors(shell)
    expect(doors).toHaveLength(1)
    // turned a quarter, a local (x, z) maps to world (x0 + z, z0 - x)
    const door = { x: shell.position[0] + doors[0]!.z, z: shell.position[2] - doors[0]!.x }
    const halfL = (shell.params.lengthSections * 10) / 2
    expect(door.z).toBeCloseTo(shell.position[2] + halfL, 6) // on the south wall
    const deck = scene.parts.find((q) => q.name === 'Gallery deck' && q.type === 'part')!
    const deckEastX = deck.position[0]! + (paramsOf(deck).length as number) / 2
    const staging = scene.parts.find((q) => q.name === 'Outbound staging zone')!
    const stagingWestX = staging.position[0]! - (paramsOf(staging).length as number) / 2
    expect(door.x).toBeGreaterThan(deckEastX + 2)
    expect(door.x).toBeLessThan(stagingWestX - 2)
    // a keep-clear area is painted in front of it, centred on the door, wider than it, ending just short of its frame
    const keep = scene.parts.find((q) => q.name === 'Exit keep-clear')!
    expect(keep.position[0]).toBeCloseTo(door.x, 6)
    expect(paramsOf(keep).length as number).toBeGreaterThan(1.0)
    const keepNear = keep.position[2]! + (paramsOf(keep).width as number) / 2
    const keepFar = keep.position[2]! - (paramsOf(keep).width as number) / 2
    expect(door.z - keepNear).toBeGreaterThan(0.06)
    expect(door.z - keepNear).toBeLessThan(0.3)
    // ...and a walkway leg runs to that area, butting it
    const leg = scene.parts.find((w) => w.name?.startsWith('Walkway') && pkgId(w) === 'oip.floor-marking' &&
      w.rotationY === 0 && Math.abs(w.position[0]! - door.x) < 1e-6)
    expect(leg, 'no walkway leg leads to the exit door').toBeDefined()
    expect(leg!.position[2]! + (paramsOf(leg!).width as number) / 2).toBeCloseTo(keepFar, 9)
  })

  // ...and the walkway, whose south leg runs down beside the dock wall, where the columns stand the same 1.0 m in (and
  // their X-brace feet 0.6). Its legs must also not overlap each other: two striped decals coplanar at y = 0 z-fight.
  it('keeps the walkway clear of the dock wall columns, with no two legs overlapping', () => {
    const scene = createPlcDemoScene()
    const shell = scene.parts.find((p) => p.type === 'building')!
    const halfW = ((shell.params as { widthSections: number }).widthSections * 10) / 2
    // turned a quarter, local -z is world -x: the dock wall
    const columnFaceX = shell.position[0]! - halfW + 1.0
    const legs = scene.parts.filter((p) => p.name?.startsWith('Walkway') && pkgId(p) === 'oip.floor-marking').map((w) => {
      // a marking lays `length` along its local x and `width` along z; turned a quarter, they swap
      const along = w.rotationY === 0
      const hx = ((along ? paramsOf(w).length : paramsOf(w).width) as number) / 2
      const hz = ((along ? paramsOf(w).width : paramsOf(w).length) as number) / 2
      return { x0: w.position[0]! - hx, x1: w.position[0]! + hx, z0: w.position[2]! - hz, z1: w.position[2]! + hz }
    })
    expect(legs.length).toBeGreaterThan(1)
    for (const l of legs) expect(l.x0 - columnFaceX).toBeGreaterThanOrEqual(0.2)
    for (let i = 0; i < legs.length; i++) for (let j = i + 1; j < legs.length; j++) {
      const a = legs[i]!, b = legs[j]!
      const overlap = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) > 1e-6 && Math.min(a.z1, b.z1) - Math.max(a.z0, b.z0) > 1e-6
      expect(overlap, `walkway legs ${i} and ${j}`).toBe(false)
    }
  })

  // The floor flows through the building: received at the west dock, shipped at the east one. The outbound staging
  // only makes sense in front of a shipping door (a staged load with no door near it is dressing that contradicts the
  // flow), so pin the pair: the east dock exists and stays shut, every outbound load stands in a lane squared to one of
  // its doors, and the rack truck's route - swing included - never reaches the bay.
  it('stages outbound loads in lanes at the east shipping dock, clear of the rack truck', () => {
    const parts = createPlcDemoScene().parts
    const shell = parts.find((p) => p.type === 'building')!
    const open = new Set(openDockOpenings(shell as never).map((o) => o.key))
    const ship = dockOpenings(shell as never).filter((o) => o.key.startsWith('3:'))
      .map((o) => ({ key: o.key, ...toWorldXZ(shell, o.x, o.z) }))
    expect(ship).toHaveLength(2)
    const eastWallX = shell.position[0]! + ((shell.params as { widthSections: number }).widthSections * 10) / 2
    for (const d of ship) {
      expect(d.x).toBeCloseTo(eastWallX, 6) //         on the east wall
      expect(open.has(d.key)).toBe(false) //            ...shut: its trailer waits for a load
    }
    const loads = parts.filter((p) => p.name?.startsWith('Outbound load'))
    expect(loads.length).toBeGreaterThan(6)
    for (const l of loads) {
      const door = ship.find((d) => Math.abs(l.position[2]! - d.z) < 1)
      expect(door, l.name).toBeDefined()
      expect(door!.x - l.position[0]!, `${l.name} leaves the dock apron clear`).toBeGreaterThanOrEqual(4)
      for (const r of RACK_ROUTE) {
        expect(Math.hypot(l.position[0]! - r[0]!, l.position[2]! - r[1]!), l.name).toBeGreaterThan(SWING_RADIUS + 1)
      }
    }
    // and the walkway leads to the bay without running into it
    const zone = parts.find((p) => p.name === 'Outbound staging zone' && pkgId(p) === 'oip.floor-marking')!
    const zoneWestX = zone.position[0]! - (paramsOf(zone).length as number) / 2
    const mainLeg = parts.filter((p) => p.name?.startsWith('Walkway') && pkgId(p) === 'oip.floor-marking' && p.rotationY !== 0)
      .map((w) => w.position[0]! + (paramsOf(w).width as number) / 2)
    expect(Math.max(...mainLeg)).toBeLessThan(zoneWestX)
    expect(zoneWestX - Math.max(...mainLeg)).toBeLessThan(1)
  })

  // Floor paint, as a whole. Markings are coplanar decals, so two whose paint overlaps z-fight. A zone border drawn up
  // against a wall column reads as a line round the column (this guards against a border 0.06 m from one). A parking
  // bay drawn round a truck's origin instead of its footprint leaves the forks 0.68 m out of the front of the bay,
  // which for the rack truck puts them across the storage zone's border. Every marking here is axis-aligned, so its
  // world rectangle is its footprint turned by a multiple of a quarter.
  describe('floor markings', () => {
    type Rect = { x0: number; x1: number; z0: number; z1: number }
    const rectOf = (p: PartInstance, lx0: number, lx1: number, lz0: number, lz1: number): Rect => {
      const c = [[lx0, lz0], [lx1, lz1]].map(([a, b]) => toWorldXZ(p, a!, b!))
      return { x0: Math.min(c[0]!.x, c[1]!.x), x1: Math.max(c[0]!.x, c[1]!.x), z0: Math.min(c[0]!.z, c[1]!.z), z1: Math.max(c[0]!.z, c[1]!.z) }
    }
    /** what a marking actually paints: the whole rectangle, or for a border its four bands */
    const paintOf = (m: PartInstance): Rect[] => {
      const { length: L, width: W, style, borderWidth } = paramsOf(m) as { length: number; width: number; style: string; borderWidth?: number }
      if (style !== 'border') return [rectOf(m, -L / 2, L / 2, -W / 2, W / 2)]
      const b = Math.min(borderWidth ?? 0.1, L / 2, W / 2)
      return [
        rectOf(m, -L / 2, -L / 2 + b, -W / 2, W / 2), rectOf(m, L / 2 - b, L / 2, -W / 2, W / 2),
        rectOf(m, -L / 2 + b, L / 2 - b, -W / 2, -W / 2 + b), rectOf(m, -L / 2 + b, L / 2 - b, W / 2 - b, W / 2),
      ]
    }
    const overlap = (a: Rect, b: Rect): number =>
      Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)) * Math.max(0, Math.min(a.z1, b.z1) - Math.max(a.z0, b.z0))
    const gap = (a: Rect, b: Rect): number =>
      Math.hypot(Math.max(0, a.x0 - b.x1, b.x0 - a.x1), Math.max(0, a.z0 - b.z1, b.z0 - a.z1))
    const scene = createPlcDemoScene()
    const markings = byPkg(scene.parts, 'oip.floor-marking')

    it('never paints over other paint', () => {
      expect(markings.length).toBeGreaterThan(8)
      for (let i = 0; i < markings.length; i++) for (let j = i + 1; j < markings.length; j++) {
        const a = paintOf(markings[i]!).reduce((s, p) => s + paintOf(markings[j]!).reduce((t, q) => t + overlap(p, q), 0), 0)
        expect(a, `${markings[i]!.name} x ${markings[j]!.name}`).toBeLessThan(1e-9)
      }
    })

    it('stands no bollard or guard rail on paint', () => {
      const standing = [...byPkg(scene.parts, 'oip.bollards'), ...byPkg(scene.parts, 'oip.guard-rail')]
      expect(standing.length).toBeGreaterThan(0)
      for (const s of standing) {
        const prm = paramsOf(s)
        // a bollard row's posts run along its local x, each on a square plate 2.25 post radii in half-width; the
        // rail's posts and rails sit inside its 0.08 m bounds width
        const [hx, hz] = pkgId(s) === 'oip.bollards'
          ? [((prm.count as number) - 1) * (prm.spacing as number) / 2 + 2.25 * (prm.radius as number), 2.25 * (prm.radius as number)]
          : [(prm.length as number) / 2, 0.04]
        const foot = rectOf(s, -hx, hx, -hz, hz)
        for (const m of markings) for (const p of paintOf(m)) {
          expect(overlap(foot, p), `${s.name} on ${m.name}`).toBeLessThan(1e-9)
        }
      }
    })

    it('keeps every marking a quarter metre off the wall columns', () => {
      const shell = scene.parts.find((p) => p.type === 'building')!
      const fp = partFootprint(shell)
      const wall = rectOf(shell, -fp.hx, fp.hx, -fp.hz, fp.hz)
      // The wall modules' framing at floor level, measured off the GLBs: a column at every 10 m cell edge, standing
      // 1.0 m into the room and, with Wall_A/B's brace feet, 0.43 m along the wall either side of the edge. Between
      // the columns the floor runs right up to the cladding (where the exit leg meets its door).
      const COLUMN_PROUD = 1.0
      const COLUMN_HALF = 0.43
      const CLEAR = 0.25
      const columns: Rect[] = []
      for (let x = wall.x0; x <= wall.x1 + 1e-6; x += 10) {
        columns.push({ x0: x - COLUMN_HALF, x1: x + COLUMN_HALF, z0: wall.z0, z1: wall.z0 + COLUMN_PROUD })
        columns.push({ x0: x - COLUMN_HALF, x1: x + COLUMN_HALF, z0: wall.z1 - COLUMN_PROUD, z1: wall.z1 })
      }
      for (let z = wall.z0; z <= wall.z1 + 1e-6; z += 10) {
        columns.push({ x0: wall.x0, x1: wall.x0 + COLUMN_PROUD, z0: z - COLUMN_HALF, z1: z + COLUMN_HALF })
        columns.push({ x0: wall.x1 - COLUMN_PROUD, x1: wall.x1, z0: z - COLUMN_HALF, z1: z + COLUMN_HALF })
      }
      for (const m of markings) {
        const L = paramsOf(m).length as number, W = paramsOf(m).width as number
        const r = rectOf(m, -L / 2, L / 2, -W / 2, W / 2)
        const clear = Math.min(...columns.map((c) => gap(r, c)))
        expect(clear, `${m.name}: ${clear.toFixed(3)} m off the columns`).toBeGreaterThanOrEqual(CLEAR - 1e-9)
        // ...and inside the cladding
        expect(Math.min(r.x0 - wall.x0, wall.x1 - r.x1, r.z0 - wall.z0, wall.z1 - r.z1), m.name).toBeGreaterThan(0)
      }
    })

    // ...and a bay's lines either share a line with other paint (butted, as the rack truck's does the storage zone's
    // east border) or stand a clear half metre off it: between the two, a pair of parallel lines reads as one line
    // drawn twice (e.g. a bay 0.44 m beside that border)
    it("parks each truck inside its bay, forks and all, and keeps the bay's paint clear of other paint", () => {
      // AGV.glb: the chassis ends 0.675 m behind the origin, the blades reach heel + length ahead, 0.63 either side
      const TAIL = 0.675, TIP = AGV_TINE_HEEL + AGV_TINE_LENGTH, HALF_W = 0.63
      for (const name of ['Rack truck', 'Supply truck']) {
        const truck = byPkg(scene.parts, 'oip.agv').find((p) => p.name === name)!
        const bay = markings.find((m) => m.name === `${name} bay`)!
        const body = rectOf(truck, -TAIL, TIP, -HALF_W, HALF_W)
        const b = paramsOf(bay).borderWidth as number
        const L = paramsOf(bay).length as number, W = paramsOf(bay).width as number
        const inside = rectOf(bay, -L / 2 + b, L / 2 - b, -W / 2 + b, W / 2 - b)
        expect(body.x0, name).toBeGreaterThan(inside.x0)
        expect(body.x1, name).toBeLessThan(inside.x1)
        expect(body.z0, name).toBeGreaterThan(inside.z0)
        expect(body.z1, name).toBeLessThan(inside.z1)
        for (const other of markings) {
          if (other === bay) continue
          const g = Math.min(...paintOf(bay).flatMap((p) => paintOf(other).map((q) => gap(p, q))))
          expect(g < 1e-9 || g >= 0.5 - 1e-9, `${bay.name} to ${other.name}: ${g.toFixed(3)} m`).toBe(true)
        }
      }
    })
  })

  // The pedestrian walkway runs along the line's south side, past the turning plow, which hangs off the infeed on
  // that side. At WALK_Z 3.4 the paint ran under the plow's old pedestal: a walkway leading people into a machine.
  it('runs the walkway clear of the turning plow', () => {
    const parts = createPlcDemoScene().parts
    const walkways = parts.filter((p) => p.name?.startsWith('Walkway') && pkgId(p) === 'oip.floor-marking')
    const main = walkways.filter((w) => w.rotationY !== 0) // the legs along x; the one running down to the stair is rotY 0
    expect(main.length).toBeGreaterThan(0)
    // the plow's footprint box, which is the machine: from its blade to its cylinder's end cap (bounds.params)
    const plow = parts.find((q) => q.name === 'Turning plow')!
    expect(plow.rotationY).toBe(0)
    const fp = partFootprint(plow)
    const farZ = plow.position[2]! + (fp.cz ?? 0) + fp.hz
    for (const w of main) {
      // a marking turned a quarter lays its `length` across z
      const nearZ = w.position[2]! - (paramsOf(w).length as number) / 2
      expect(nearZ - farZ, w.name).toBeGreaterThanOrEqual(0.3)
    }
  })

  it('includes a palletizer with a layer head: a plate sized to the layer, which is its pickup volume', () => {
    const arm = byPkg(createPlcDemoScene().parts, 'oip.six-axis-robot')[0]!
    const prm = paramsOf(arm)
    // C-multigrab: the plate footprint is the pickup volume 1:1, so a plate sized under the layer is what makes the
    // arm take all five cases at once. Shrink it and the cell stalls with cases left standing on the table.
    // authored in the arm's own units, so the drawn plate is these times robotScale - the layer, 1.2 x 1.0
    expect((prm.toolSizeX as number) * (prm.scale as number)).toBeCloseTo(1.2, 6)
    expect((prm.toolSizeZ as number) * (prm.scale as number)).toBeCloseTo(1.0, 6)
    // home + 6 trained poses (apex/pick over the table, apex + three courses over the pallet)
    const waypoints = prm.waypoints as number[][]
    expect(waypoints).toHaveLength(7)
    expect(waypoints.every((w) => w.length === 6)).toBe(true)
  })

  it('includes the pallet-change loop: a truck that carries whole loads, plus a build pallet and a dispenser', () => {
    const parts = createPlcDemoScene().parts
    const agv = byPkg(parts, 'oip.agv')[0]!
    // C-multigrab is the fork volume's doing (asserted in agvRigParity): a pallet driven away without its stack
    // would leave the cases standing in mid-air
    expect((paramsOf(agv).waypoints as number[][]).length).toBeGreaterThanOrEqual(3)
    expect(byPkg(parts, 'oip.pallet-dispenser')).toHaveLength(1)
    expect(byPkg(parts, 'oip.pallet-spawner')).toHaveLength(0) // pallets come from the machine, not out of the air
    expect(byPkg(parts, 'oip.pallet').length).toBeGreaterThan(0)
    expect(byPkg(parts, 'oip.fence').length).toBeGreaterThanOrEqual(1)
    expect(byPkg(parts, 'oip.safety-gate')).toHaveLength(1)
  })

  // Putting a load ON a shelf is a geometry claim about the rack it goes in, so pin it here rather than leave it
  // to a screenshot. oip.rack's level L (1 = bottom): slab top at L x spacing + S/2 (1.62, 3.22, ...), load beams
  // standing 0.01 proud of it, an end frame every poleInterval: one bay, two pallets wide.
  it('has the rack truck stand each load in a free rack bay, on a shelf it can reach', () => {
    const SPACING = 1.6
    const slabTop = (level: number): number => level * SPACING + 0.02
    const lipTop = (level: number): number => level * SPACING + 0.03
    const slabBottom = (level: number): number => level * SPACING - 0.02
    /** a delivered load: pallet + three 0.4 m courses - what has to fit under the next shelf up on the way in */
    const LOAD_H = PALLET_SIZE[1] + 3 * 0.4
    const DECK_H = CELL.palletDeckH // the staging lane's conveying height - where a picked load is standing
    /** two route rows describing the same spot (a row pair that only changes fork height stands still) */
    const same = (a: readonly number[], b: readonly number[]): boolean => a[0] === b[0] && a[1] === b[1] && a[2] === b[2]
    const parts = createPlcDemoScene().parts
    const rackParts = byPkg(parts, 'oip.rack')
    const racks = rackParts.map((r) => r.position)
    expect(racks).toHaveLength(3)
    // the rack truck's mast ceiling: every height its route asks for has to be one it can actually reach, or the
    // truck clamps and drives a load into the beams it was meant to clear
    const rackTruck = byPkg(parts, 'oip.agv').find((p) => paramsOf(p).commandTag === 'RackCmd')!
    const maxLift = paramsOf(rackTruck).maxLiftHeight as number
    for (const row of RACK_ROUTE) expect(row[3]!).toBeLessThanOrEqual(maxLift)
    // the slots already holding dressing stock, by level: a delivery must not be aimed at one
    const stocked = [...byPkg(parts, 'oip.pallet'), ...byPkg(parts, 'oip.unit-load')]
      .filter((p) => p.position[1] > 1) // on a shelf, not the floor
      .map((p) => [p.position[0], p.position[2], Math.floor(p.position[1] / SPACING)] as const)

    const slots: string[] = []
    {
      const route = RACK_ROUTE
      // Rows 0..5 are home + the five-row pick, and the shape of it is the point: line up back down the lane with
      // the blades down (the only row that turns), raise to pocket height standing still in free air, drive
      // straight in at that height, take the weight standing still, reverse straight out. The invariant under all
      // of it is that the blades never change height while they are inside anything (rising inside the staging
      // conveyor sweeps its bed).
      const [lineUp, raise, enter, hoist, back] = [route[1]!, route[2]!, route[3]!, route[4]!, route[5]!]
      expect(lineUp[3]).toBe(0) //                                        blades down where it turns
      expect(same(raise, lineUp)).toBe(true) //                           raise standing still...
      expect(raise[3]!).toBeGreaterThan(0)
      expect(same(enter, lineUp)).toBe(false) //                          ...then drive, at that same height
      expect(enter[2]).toBe(lineUp[2]) //                                 straight in on the heading it turned to
      expect(enter[3]).toBe(raise[3])
      expect(same(hoist, enter)).toBe(true) //                            take the weight standing still
      expect(hoist[3]!).toBeGreaterThan(enter[3]!)
      expect(same(back, lineUp)).toBe(true) //                            and reverse to the spot it can turn on
      expect(back[3]).toBe(hoist[3]) //                                   ...without changing height on the way
      // the blade enters below the load's deck and above what it stands on - i.e. into the fork pocket, which is
      // the whole reason this order works now and did not before (core/palletForkFit.test.ts pins the fit)
      expect(enter[3]! + AGV_TINE_RISE).toBeGreaterThan(DECK_H)
      expect(enter[3]! + AGV_TINE_RISE + AGV_TINE_THICKNESS).toBeLessThan(DECK_H + PALLET_POCKET_HEIGHT)
      const rows = route.slice(RACK_BAY_BASE)
      expect(rows.length % 4).toBe(0)
      expect(rows.length / 4).toBeGreaterThanOrEqual(2) // more than one bay, or deliveries land on each other
      for (let i = 0; i < rows.length; i += 4) {
        const [lineup, over, down, out] = [rows[i]!, rows[i + 1]!, rows[i + 2]!, rows[i + 3]!]
        // in and down are the same spot at two fork heights - a lower-in-place, not a second drive
        expect([down[0], down[1], down[2]]).toEqual([over[0], over[1], over[2]])
        // and the truck lines up out in the aisle before driving in, on the heading it will hold all the way:
        // it sweeps SWING_RADIUS wherever it turns, and the only place on the run with that much room is back
        // here (how much room, exactly, is the clearance spec below - this only pins the shape of the move)
        expect(lineup[2]).toBe(over[2])
        expect(Math.hypot(lineup[0]! - over[0]!, lineup[1]! - over[1]!)).toBeGreaterThan(1.4)
        // ...and it reverses back out to that same spot, which is where it is free to turn for home
        expect([out[0], out[1], out[2]]).toEqual([lineup[0], lineup[1], lineup[2]])
        // the load ends up standing on a slab, and came in over its lip beams. The load is what has to clear
        // them: it hangs CARRY.rise below the lift datum, because the blade is inside its pockets, not under it.
        const level = Math.round((down[3]! + CARRY.rise) / SPACING)
        expect(level).toBeGreaterThanOrEqual(1)
        expect(level).toBeLessThanOrEqual(3) // a real shelf of the rack's four, with one above it
        const SLAB_TOP = slabTop(level), SLAB_BOTTOM = slabBottom(level)
        expect(down[3]! + CARRY.rise).toBeCloseTo(SLAB_TOP, 3)
        expect(over[3]! + CARRY.rise).toBeGreaterThan(lipTop(level))
        // ...and the top of that load clears the next shelf's slab on the way in
        expect(over[3]! + CARRY.rise + LOAD_H).toBeLessThan(slabBottom(level + 1))
        // ...in a free pallet position of a real rack, centred in its depth: inside one bay, clear of both its
        // uprights (the 0.08 posts on the bay's end lines), and overhanging the frame a little front and back
        const [lx, lz] = carriedLoadSpot(down[0]!, down[1]!, down[2]!)
        slots.push(`${lx.toFixed(2)}@${level}`)
        const ri = racks.findIndex((r) => Math.abs(r[2] - lz) < 0.05)
        expect(ri, `no rack at z=${lz.toFixed(2)}`).toBeGreaterThanOrEqual(0)
        const rp = paramsOf(rackParts[ri]!)
        const [bayW, rackLen, frame] = [rp.poleInterval as number, rp.length as number, rp.depth as number]
        const along = lx - racks[ri]![0] + rackLen / 2 //   from the run's west end line
        const bay = Math.floor(along / bayW)
        expect(bay, `load at x=${lx.toFixed(2)} is off the end of the rack`).toBeGreaterThanOrEqual(0)
        expect(bay).toBeLessThan(Math.round(rackLen / bayW))
        const [lo, hi] = [along - PALLET_SIZE[0] / 2 - bay * bayW, (bay + 1) * bayW - (along + PALLET_SIZE[0] / 2)]
        expect(Math.min(lo, hi), `load at x=${lx.toFixed(2)} stands ${Math.min(lo, hi).toFixed(3)} m off an upright's centreline`).toBeGreaterThan(0.04 + 0.05)
        expect(PALLET_SIZE[2]).toBeGreaterThan(frame) //   the pallet spans both beams and overhangs them
        expect(PALLET_SIZE[2] - frame).toBeLessThan(0.2)
        for (const [sx, sz, sl] of stocked) {
          if (sl !== level) continue
          expect(Math.hypot(sx - lx, sz - lz), `bay at ${lx.toFixed(2)},${lz.toFixed(2)} level ${level} already holds stock`).toBeGreaterThan(1)
        }
        // a load goes in above another only after that one is in: the level below this bay is stock or an earlier
        // delivery, never a later one (which would be reached in under a load already standing over it)
        if (level > 1) expect(slots, `level ${level} at x=${lx.toFixed(2)} filled before the level below it`).toContain(`${lx.toFixed(2)}@${level - 1}`)
        // it backs straight out - turning in the bay would sweep two metres of fork through the uprights and
        // through the load just set down
        const backOut = Math.hypot(out[0]! - down[0]!, out[1]! - down[1]!)
        expect(backOut).toBeGreaterThan(0.8) // 0.72 m of tine is inside the bay
        expect(backOut).toBeLessThanOrEqual(3) // ...and the AGV's reverseRange, or it turns round instead
        // ...and it withdraws through the load's own fork pockets. This guards against dropping the blades to
        // 0.8 m to pull them out, which from 1.541 m goes straight down through the 1.58 to 1.62 slab the load
        // was just set on. The blades stay in the pocket: clear above the slab, clear below the deck of the load
        // resting on it, and slide straight out sideways.
        expect(out[3]! + AGV_TINE_RISE).toBeGreaterThan(SLAB_TOP)
        expect(out[3]! + AGV_TINE_RISE + AGV_TINE_THICKNESS).toBeLessThan(SLAB_TOP + PALLET_POCKET_HEIGHT)
        expect(SLAB_BOTTOM).toBeLessThan(SLAB_TOP) // (the slab it must not pass through)
      }
    }
    // Different slots, each delivered to once: the truck fills them in turn, so no delivery lands on another
    expect(slots).toHaveLength(RACK_SLOTS)
    expect(new Set(slots).size).toBe(slots.length)
    // ...and more than one height, which is the point of the route saying how high to hold the tines
    expect(new Set(slots.map((s) => s.split('@')[1])).size).toBeGreaterThan(1)
  })

  /**
   * Where the trucks drive, as geometry rather than as a screenshot.
   *
   * The test above pins each end of a run - blades in the pocket, load on the slab. It says nothing about the
   * ground between them, where a truck pivoting with a load can sweep its blades through a rack upright. Nothing
   * would collide (a truck's base and its grip are kinematic, the racks static dressing) or error, and every gate
   * would stay green, so it is pinned here.
   *
   * Two rules, one walk of the route the ST actually commands:
   *
   *   1. A spot a truck turns on must clear every rack by {@link SWING_RADIUS} + {@link TURN_CLEARANCE}, whichever
   *      way it turns. Not the arc it happens to sweep today - the whole circle. This is the layout invariant:
   *      CELL_RACK_AISLE and RACK_STANDOFF are both derived from it, so a rack line or a standoff that stops
   *      satisfying it fails here instead of on screen.
   *   2. ...and the poses it actually passes through - the pivots it makes, the straight runs between them - keep
   *      the truck's own footprint (chassis, blades, and the load when it is carrying one) clear of every rack,
   *      fence and conveyor. This one is arc-accurate, because the cell's north-east fence post stands 2.17 m off
   *      truck B's lane standoff and only the direction it turns keeps its blades out of it.
   *
   * The intended interpenetrations are skipped, not fudged: driving the blades into a load standing on a lane,
   * and reaching a load into a bay, are the whole point of those rows and are pinned above (and by
   * e2e/verify-agv-lane-pick.mjs) at the height that makes them legal.
   */
  it('never turns or hauls a truck within reach of a rack, a fence or a lane', () => {
    type Poly = [number, number][]
    const D2R = Math.PI / 180
    /** rectangle centred at (cx, cz), `hx` along its heading and `hz` across it */
    const rect = (cx: number, cz: number, hx: number, hz: number, yaw: number): Poly => {
      const fx = Math.cos(yaw), fz = -Math.sin(yaw)
      return ([[1, 1], [1, -1], [-1, -1], [-1, 1]] as const).map(
        ([a, b]) => [cx + a * hx * fx - b * hz * fz, cz + a * hx * fz + b * hz * fx] as [number, number])
    }
    const segDist = (p: [number, number], a: [number, number], b: [number, number]): number => {
      const [vx, vz] = [b[0] - a[0], b[1] - a[1]]
      const L = vx * vx + vz * vz
      const t = L < 1e-12 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * vx + (p[1] - a[1]) * vz) / L))
      return Math.hypot(p[0] - (a[0] + t * vx), p[1] - (a[1] + t * vz))
    }
    const inside = (p: [number, number], poly: Poly): boolean => {
      let sign = 0
      for (let i = 0; i < poly.length; i++) {
        const a = poly[i]!, b = poly[(i + 1) % poly.length]!
        const cr = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])
        if (Math.abs(cr) < 1e-12) continue
        if (sign === 0) sign = Math.sign(cr)
        else if (Math.sign(cr) !== sign) return false
      }
      return true
    }
    /** gap between two convex polygons - 0 once they touch or overlap */
    const gap = (A: Poly, B: Poly): number => {
      for (const p of A) if (inside(p, B)) return 0
      for (const p of B) if (inside(p, A)) return 0
      let best = Infinity
      for (const [P, Q] of [[A, B], [B, A]] as const) {
        for (const p of P) for (let i = 0; i < Q.length; i++) best = Math.min(best, segDist(p, Q[i]!, Q[(i + 1) % Q.length]!))
      }
      return best
    }
    /** distance from a point to an axis-aligned box (0 inside) - the turning-circle rule's whole geometry */
    const toBox = (px: number, pz: number, b: number[]): number =>
      Math.hypot(Math.max(b[0]! - px, 0, px - b[2]!), Math.max(b[1]! - pz, 0, pz - b[3]!))

    // ...what a truck is, in its own frame: rig.json's hidden chassis box (1.48 x 1.19, offset x 0.065), the pair
    // of blades (core AGV_TINE_*: 0.82..2.08 ahead, outer edge 0.42 off the centreline) and, when it has one, the
    // load riding CARRY.fwd ahead with its 1.02 m width along the blades.
    const BODY = [{ cx: 0.065, hx: 0.74, hz: 0.595 }, { cx: 1.45, hx: 0.63, hz: 0.42 }]
    const LOAD = { cx: CARRY.fwd, hx: 1.02 / 2, hz: 1.22 / 2 }
    const truckAt = (x: number, z: number, yaw: number, loaded: boolean): Poly[] =>
      (loaded ? [...BODY, LOAD] : BODY).map((o) =>
        rect(x + o.cx * Math.cos(yaw), z - o.cx * Math.sin(yaw), o.hx, o.hz, yaw))

    const parts = createPlcDemoScene().parts
    const racks: { name: string; box: number[] }[] = []
    const fixtures: { name: string; poly: Poly }[] = []
    for (const p of parts) {
      const prm = paramsOf(p)
      const [px, , pz] = p.position
      const ry = (p as { rotationY?: number }).rotationY ?? 0
      const len = (prm.length as number) ?? 0
      if (pkgId(p) === 'oip.rack') {
        // the rack's depth (the demo pins it) + the 0.08 uprights' half-thickness
        const hz = (prm.depth as number) / 2 + 0.04
        const box = [px - len / 2 - 0.04, pz - hz, px + len / 2 + 0.04, pz + hz]
        racks.push({ name: `${p.name} @${px.toFixed(1)},${pz.toFixed(1)}`, box })
        fixtures.push({ name: racks[racks.length - 1]!.name, poly: [[box[0]!, box[1]!], [box[2]!, box[1]!], [box[2]!, box[3]!], [box[0]!, box[3]!]] })
      } else if (pkgId(p) === 'oip.bollards') {
        // the row's posts along its local x, each with its square base plate (2.25 post radii half-width)
        const n = prm.count as number, sp = prm.spacing as number, half = 2.25 * (prm.radius as number)
        fixtures.push({ name: `${p.name} @${px.toFixed(1)},${pz.toFixed(1)}`, poly: rect(px, pz, ((n - 1) * sp) / 2 + half, half, ry) })
      } else if (pkgId(p) === 'oip.fence' || pkgId(p) === 'oip.safety-gate' || pkgId(p) === 'oip.guard-rail') {
        fixtures.push({ name: `${p.name} @${px.toFixed(1)},${pz.toFixed(1)}`, poly: rect(px, pz, len / 2, 0.05, ry) })
      } else if (pkgId(p) === 'oip.roller-conveyor' || pkgId(p) === 'oip.turntable-conveyor') {
        const w = (prm.width as number) ?? 1
        fixtures.push({ name: `${p.name} @${px.toFixed(1)},${pz.toFixed(1)}`, poly: rect(px, pz, (len || w) / 2, w / 2, ry) })
      }
    }
    expect(racks).toHaveLength(3)
    // ...and the building: its wall columns stand 1.0 m in from the cladding (see the catwalk spec above), and nothing
    // in the scene model knows they are there. A second staging lane once discharged north, toward that wall, and
    // the truck serving it swung bare blades past the column line to within 0.2 m of the cladding.
    {
      const shell = parts.find((p) => p.type === 'building')!
      const prm = shell.params as { lengthSections: number; widthSections: number }
      // turned a quarter: lengthSections runs along world z, widthSections along world x
      const [hx, hz] = [(prm.widthSections * 10) / 2, (prm.lengthSections * 10) / 2]
      const [cx, cz] = [shell.position[0]!, shell.position[2]!]
      const [x0, x1, z0, z1] = [cx - hx, cx + hx, cz - hz, cz + hz]
      const strip = (a: number, b: number, c: number, d: number): Poly => [[a, c], [b, c], [b, d], [a, d]]
      fixtures.push(
        { name: 'north wall columns', poly: strip(x0, x1, z0, z0 + 1.0) },
        { name: 'south wall columns', poly: strip(x0, x1, z1 - 1.0, z1) },
        { name: 'dock wall columns', poly: strip(x0, x0 + 1.0, z0, z1) },
        { name: 'far wall columns', poly: strip(x1 - 1.0, x1, z0, z1) },
      )
    }

    {
      const route = RACK_ROUTE
      for (let slot = 0; slot < RACK_SLOTS; slot++) {
        const bay = RACK_BAY_BASE + 4 * slot
        // the rows the truck drives into something on: the three that follow each lineup, at both ends
        const entering = new Set([AGV_PICK_BASE + 2, AGV_PICK_BASE + 3, AGV_PICK_BASE + 4, bay + 1, bay + 2, bay + 3])
        const order = commandOrder(slot)
        let x: number = route[0]![0]!, z: number = route[0]![1]!
        let yaw: number = route[0]![2]! * D2R
        let loaded = false
        for (let i = 1; i < order.length; i++) {
          const to = order[i]!
          const t = route[to]!
          const [tx, tz, tyaw] = [t[0]!, t[1]!, t[2]! * D2R]
          if (to === AGV_PICK_BASE + 3) loaded = true //  the grip latches on the hoist...
          if (to === bay + 2) loaded = false //           ...and lets go as the load settles on the slab
          if (!entering.has(to)) {
            const where = `rack truck slot ${slot} row ${to}`
            // rule 1 - the turning circle, at every spot it is free to turn on
            for (const r of racks) {
              expect(toBox(tx, tz, r.box), `${where} turns ${toBox(tx, tz, r.box).toFixed(2)} m off ${r.name}`)
                .toBeGreaterThanOrEqual(SWING_RADIUS + TURN_CLEARANCE - 1e-9)
            }
            // rule 2 - and the poses it passes through on the way: pivot to the travel bearing, roll, settle
            const travel = Math.hypot(tx - x, tz - z) < 1e-9 ? yaw : Math.atan2(-(tz - z), tx - x)
            const poses: [number, number, number][] = []
            const arc = (a: number, b: number, ax: number, az: number): void => {
              const d = Math.atan2(Math.sin(b - a), Math.cos(b - a))
              const n = Math.max(1, Math.ceil(Math.abs(d) / (2 * D2R)))
              for (let s = 0; s <= n; s++) poses.push([ax, az, a + d * (s / n)])
            }
            arc(yaw, travel, x, z)
            const steps = Math.max(1, Math.ceil(Math.hypot(tx - x, tz - z) / 0.1))
            for (let s = 0; s <= steps; s++) poses.push([x + (tx - x) * (s / steps), z + (tz - z) * (s / steps), travel])
            arc(travel, tyaw, tx, tz)
            for (const [qx, qz, qy] of poses) {
              for (const f of fixtures) {
                for (const q of truckAt(qx, qz, qy, loaded)) {
                  expect(gap(q, f.poly), `${where} passes ${gap(q, f.poly).toFixed(2)} m from ${f.name}`).toBeGreaterThan(0.3)
                }
              }
            }
          }
          x = tx; z = tz; yaw = tyaw
        }
      }
    }
  })

  // The route gives each truck a fixed set of bays and nothing in the cell ever empties one, so what a truck does
  // after its last bay is a real question. A slot counter that wraps to 0 claims bay 0 is free, but the truck
  // filled it itself; because both the base and the load it carries are kinematic (root motion, latched grip),
  // neither stops on contact, and it plows the standing load off the back of the rack.
  //
  // This is a unit test rather than a screenshot because of when it happens: the 6th delivery, which at ~78 s a
  // load is ~8 minutes into a run. verify-agv-rack-putaway.mjs watches one delivery on a deadline, so no e2e run in
  // the fleet is long enough to reach it.
  it('parks the truck once it has used its last bay, instead of delivering onto its own first load', () => {
    const { p, step, runTruck } = runner()
    // hand it one staged load after another - more trips than it has bays to put them in
    for (let trip = 0; trip < RACK_SLOTS + 2; trip++) {
      step({ LaneFull: true })
      runTruck()
      step({ LaneFull: false })
    }
    // the counter climbs to the last bay and stops there; it never returns to a bay it already filled
    expect(p.get('TruckDone'), 'the truck never finished its bays').toBe(true)
    expect(p.get('TruckSlot')).toBe(RACK_SLOTS - 1)
    // ...and it stays parked: a further staged load does not dispatch it. A counter that wraps fails
    // here: the dispatcher leaves step 0 and goes back out to an occupied bay.
    step({ LaneFull: true }, 5)
    expect(p.get('TruckStep'), 'the truck accepted a load with no bay left to put it in').toBe(0)
  })

  // The supply truck, as geometry. It is the one truck that reaches into a machine rather than onto a lane or a
  // shelf, and it does so over a conveyor's side rail, so the numbers that matter are all pinned here: that each
  // pick is at a real stack and each load is set down centred in the magazine, standing on the infeed; and that every
  // spot it turns on clears the cell's fence, the conveyors, the dispenser and the stock still standing by a whole
  // turning circle, which is what DISPENSER_X and SUPPLY_TURN_Z are derived from.
  it('stacks its unit loads in the layer the palletizer builds', () => {
    // a load a unit load stacks itself (core/frame UNIT_LAYER) must read as one the robot built (LAYER_PATTERN)
    expect(UNIT_LAYER).toEqual(LAYER_PATTERN)
  })

  it('has the supply truck load the dispenser from its stock, and turn only where it has room', () => {
    const parts = createPlcDemoScene().parts
    const disp = parts.find((p) => pkgId(p) === 'oip.pallet-dispenser')!
    const route = SUPPLY_ROUTE
    const truck = parts.find((p) => p.name === 'Supply truck')!
    expect(paramsOf(truck).waypoints as number[][]).toEqual(route.map((r) => [...r]))
    // the magazine starts nearly empty, so the first load is in the first minute: one authored pallet, held at its
    // bottom position (parented to it, as the Inspector's Fill places them), and no count for the run to make more
    const held = parts.filter((p) => p.parent === disp.id)
    expect(held.map(pkgId)).toEqual(['oip.pallet'])
    expect(paramsOf(disp).stock ?? 0).toBe(0)
    // ...and the floor stock holds whole stacks
    const stock = parts.filter((p) => pkgId(p) === 'oip.pallet' && p.parent !== disp.id && Math.abs(p.position[0] - disp.position[0]) < 0.01 && p.position[1] < 1.2)
    expect(stock).toHaveLength(SUPPLY_STACK * SUPPLY_STOCK_Z.length)
    const turns: number[][] = [route[0]! as number[]]
    for (let k = 0; k < SUPPLY.slots; k++) {
      const pick = route.slice(SUPPLY.pickBase + SUPPLY.pickStride * k, SUPPLY.pickBase + SUPPLY.pickStride * (k + 1)) as number[][]
      const [lineUp, raise, enter, hoist, back] = pick as [number[], number[], number[], number[], number[]]
      expect(raise.slice(0, 3)).toEqual(lineUp.slice(0, 3)) //    raise standing still
      expect(hoist.slice(0, 3)).toEqual(enter.slice(0, 3)) //     take the weight standing still
      expect(back.slice(0, 3)).toEqual(lineUp.slice(0, 3)) //     reverse to where it turned
      const [lx, lz] = carriedLoadSpot(enter[0]!, enter[1]!, enter[2]!)
      expect(lx).toBeCloseTo(disp.position[0], 6)
      expect(lz).toBeCloseTo(SUPPLY_STOCK_Z[k]!, 6) //           centred on stack k...
      expect(stock.filter((p) => Math.abs(p.position[2] - lz) < 0.01)).toHaveLength(SUPPLY_STACK) // ...which is there
      expect(enter[3]! + AGV_TINE_RISE).toBeGreaterThan(0) //    into the bottom pallet's pockets
      expect(enter[3]! + AGV_TINE_RISE + AGV_TINE_THICKNESS).toBeLessThan(PALLET_POCKET_HEIGHT)
      const drop = route.slice(SUPPLY.dropBase + 4 * k, SUPPLY.dropBase + 4 * (k + 1)) as number[][]
      const [dLine, dIn, dSet, dOut] = drop as [number[], number[], number[], number[]]
      expect(dLine.slice(0, 2)).toEqual(back.slice(0, 2)) //     it turns to face the machine where it backed out to
      const [mx, mz] = carriedLoadSpot(dIn[0]!, dIn[1]!, dIn[2]!)
      expect(mx).toBeCloseTo(disp.position[0], 6) //             centred in the magazine
      expect(mz).toBeCloseTo(disp.position[2], 6)
      expect(dIn[3]! + CARRY.rise).toBeGreaterThan(disp.position[1] + 0.05) // in over the infeed's side rail
      expect(dSet.slice(0, 3)).toEqual(dIn.slice(0, 3))
      expect(dSet[3]! + CARRY.rise).toBeCloseTo(disp.position[1], 6) //       standing ON the infeed
      expect(dOut.slice(0, 3)).toEqual(dLine.slice(0, 3))
      expect(Math.hypot(dOut[0]! - dIn[0]!, dOut[1]! - dIn[1]!)).toBeLessThanOrEqual(3.5) // a reverse, not a turn
      turns.push(lineUp, dLine)
    }
    // every spot it turns on: a whole turning circle clear of the steel around it...
    const boxes: { name: string; box: number[] }[] = []
    for (const p of parts) {
      const prm = paramsOf(p)
      const [px, , pz] = p.position
      const ry = (p as { rotationY?: number }).rotationY ?? 0
      const along = Math.abs(Math.cos(ry)) > 0.5
      const box = (hx: number, hz: number): number[] => along ? [px - hx, pz - hz, px + hx, pz + hz] : [px - hz, pz - hx, px + hz, pz + hx]
      if (pkgId(p) === 'oip.fence') boxes.push({ name: `${p.name} @${px.toFixed(1)},${pz.toFixed(1)}`, box: box((prm.length as number) / 2, 0.05) })
      // a roller conveyor's origin is its tail; its bed runs +length along its heading
      if (pkgId(p) === 'oip.roller-conveyor') {
        const L = prm.length as number, W = (prm.width as number) / 2 + 0.03
        const [cx, cz] = [px + (L / 2) * Math.cos(ry), pz - (L / 2) * Math.sin(ry)]
        boxes.push({ name: p.name!, box: along ? [cx - L / 2, cz - W, cx + L / 2, cz + W] : [cx - W, cz - L / 2, cx + W, cz + L / 2] })
      }
      if (pkgId(p) === 'oip.pallet-dispenser') boxes.push({ name: p.name!, box: box(1.28, 0.83) })
    }
    const toBox = (x: number, z: number, b: number[]): number => Math.hypot(Math.max(b[0]! - x, 0, x - b[2]!), Math.max(b[1]! - z, 0, z - b[3]!))
    for (const t of turns) {
      for (const b of boxes) {
        expect(toBox(t[0]!, t[1]!, b.box), `supply truck turns ${toBox(t[0]!, t[1]!, b.box).toFixed(2)} m off ${b.name}`)
          .toBeGreaterThanOrEqual(SWING_RADIUS + TURN_CLEARANCE - 1e-9)
      }
    }
    // ...and of the stock, where it turns with bare blades before a pick
    for (const z of SUPPLY_STOCK_Z) {
      const stackBox = [disp.position[0] - 0.61, z - 0.51, disp.position[0] + 0.61, z + 0.51]
      expect(toBox(turns[1]![0]!, turns[1]![1]!, stackBox)).toBeGreaterThanOrEqual(SWING_RADIUS + TURN_CLEARANCE - 1e-9)
    }
  })

  it('is fully wired: every program tag is handled, nothing unbound', () => {
    const link = demoLink()
    const { unbound, unwired } = unhandledProgramTags(createPlcDemoScene().parts, link)
    expect(unbound).toEqual([])
    expect(unwired).toEqual([])
  })

  it('carries only live annotations, each on a tag the program declares', () => {
    // A note belongs in the demo only if it says something the scene cannot show by itself. A count climbing as
    // cases go by shows the program working; a caption reading "Palletizing cell" over an arm visibly stacking a
    // pallet adds nothing. Two notes, the cell's input and its output, and both read a live value.
    const scene = createPlcDemoScene()
    const notes = scene.parts.filter((p) => p.type === 'annotation')
    expect(notes.map((n) => paramsOf(n).tag).sort()).toEqual(['Cases', 'Pallets'])
    const link = demoLink()
    for (const note of notes) {
      const params = paramsOf(note)
      expect(params.tag, 'a demo note must be LIVE - a static caption in the shop window is furniture').toBeTruthy()
      // ...and bound to something the program actually publishes, or it would read `--` forever
      expect([...link.inputs, ...link.outputs]).toContain(params.tag)
      // parented, so retuning the cell carries it instead of stranding it over empty floor
      expect(note.parent).toBeTruthy()
    }
  })

  it('wires cleanly: no contested tag, no type clash, no dangling read', () => {
    // The direction/type-aware half (plc/wiring.ts), which the check above cannot see: `unbound` /
    // `unwired` only ask whether a name is mentioned somewhere, so a scene where two parts drive one
    // tag - last writer wins, by part order - passes it while behaving nondeterministically. The demo
    // is the only scene with real comms wiring, so it is the fixture that keeps this guard meaningful.
    const scene = createPlcDemoScene()
    for (const pkg of scene.packages ?? []) registerPackage(pkg)
    const report = checkWiring(scene.parts, demoLink())
    expect(report.problems).toEqual([])
    // ...and prove the check actually looked: a registry miss or a scene with no tags wired would also
    // report zero problems, which is the shape a vacuous gate takes.
    expect(report.unresolvedPackages).toEqual([])
    expect(report.tags.length).toBeGreaterThanOrEqual(30)
    // every tag is paired: what a part reads, the program writes - and the reverse
    for (const t of report.tags) {
      const drivers = t.writers.length + (t.programWrites ? 1 : 0)
      expect(drivers, `${t.name} has ${drivers} drivers`).toBe(1)
      expect(t.readers.length + (t.programReads ? 1 : 0), `${t.name} has no reader`).toBeGreaterThanOrEqual(1)
      expect(t.type, `${t.name} declares no ST type`).not.toBeNull()
    }
  })

  it('wires each program tag to the right SDK part (over the device-IO bridge)', () => {
    const parts = createPlcDemoScene().parts
    const carriers = (tag: string): PartInstance[] =>
      parts.filter((p) => p.type === 'part' &&
        Object.values(paramsOf(p)).some((v) => v === tag))
    const carrierPkgs = (tag: string): string[] => [...new Set(carriers(tag).map((p) => pkgId(p)!))].sort()
    expect(carrierPkgs('Infeed')).toEqual(['oip.roller-conveyor'])
    expect(carrierPkgs('RowForm')).toEqual(['oip.roller-conveyor'])
    // one row's worth of cases at a time: the source in the trailer AND the path to the line stop together
    // the release is the flex's (its discharge zone); the loader in the trailer runs on the program's load light
    expect(carrierPkgs('SpawnRun')).toEqual(['oip.flex-conveyor'])
    expect(carrierPkgs('LoadFlex')).toEqual(['oip.box-spawner'])
    expect(carrierPkgs('FlexFull')).toEqual(['oip.flex-conveyor'])
    expect(carrierPkgs('Turn')).toEqual(['oip.diverter'])
    expect(carrierPkgs('Shift')).toEqual(['oip.chain-transfer'])
    expect(carrierPkgs('ShiftSpeed')).toEqual(['oip.chain-transfer'])
    for (const t of ['PalletDispense', 'DispBusy', 'PalletReady']) expect(carrierPkgs(t)).toEqual(['oip.pallet-dispenser'])
    expect(carrierPkgs('PalletInfeed')).toEqual(['oip.roller-conveyor'])
    for (const t of ['PalletLift', 'PalletXfer']) expect(carrierPkgs(t)).toEqual(['oip.chain-transfer'])
    expect(carrierPkgs('PalletIn')).toEqual(['oip.diffuse-sensor'])
    expect(carrierPkgs('Tower')).toEqual(['oip.stack-light'])
    expect(carrierPkgs('StartLamp')).toEqual(['oip.push-button'])
    for (const t of ESTOPS) expect(carrierPkgs(t)).toEqual(['oip.push-button'])
    expect(carrierPkgs('FlexRun')).toEqual(['oip.flex-conveyor'])
    expect(carrierPkgs('Guard')).toEqual(['oip.safety-gate'])
    for (const t of ['CaseCurtain', 'FeedCurtain', 'OutCurtain']) expect(carrierPkgs(t)).toEqual(['oip.light-curtain'])
    expect(carrierPkgs('BoxAtEye')).toEqual(['oip.diffuse-sensor'])
    expect(carrierPkgs('RowReady')).toEqual(['oip.diffuse-sensor'])
    expect(carrierPkgs('LayerReady')).toEqual(['oip.diffuse-sensor'])
    for (const t of ['ArmCmd', 'ArmExec', 'ArmEnable', 'ArmIdle']) expect(carrierPkgs(t)).toEqual(['oip.six-axis-robot'])
    // the pallet line: the build deck and the run out of the cell share one speed tag (they are one conveyor as
    // far as the load is concerned), and the staging lane has its own so it drives only while it is filling
    expect(carrierPkgs('PalletOut')).toEqual(['oip.roller-conveyor'])
    expect(carrierPkgs('Lane')).toEqual(['oip.roller-conveyor'])
    for (const t of ['TurnCmd', 'TurnRun', 'TurnDone']) expect(carrierPkgs(t)).toEqual(['oip.turntable-conveyor'])
    for (const t of ['TurnEye', 'LaneFull']) expect(carrierPkgs(t)).toEqual(['oip.diffuse-sensor'])
    // one truck at the racks, and one keeping the pallet dispenser loaded, each on its own tag set
    for (const t of ['RackCmd', 'RackExec', 'RackFork', 'RackIdle']) expect(carrierPkgs(t)).toEqual(['oip.agv'])
    for (const t of ['SupplyCmd', 'SupplyExec', 'SupplyFork', 'SupplyIdle']) expect(carrierPkgs(t)).toEqual(['oip.agv'])
    expect(carrierPkgs('MagLevel')).toEqual(['oip.pallet-dispenser'])
    expect(carrierPkgs('CycleEnable')).toEqual(['oip.pallet-dispenser', 'oip.stretch-wrapper', 'oip.turntable-conveyor'])
    expect(byPkg(parts, 'oip.agv')).toHaveLength(2)
  })

  it('auto-starts the line, runs the conveyors, and Stop/E-stop/Start still latch', () => {
    const { p, step } = runner()
    step()
    expect(p.get('running')).toBe(true)
    // REAL setpoints in m/s, not boolean run flags - and they are NOT the same number: the infeed is transport,
    // separate setpoints per drive, even where they carry the same number - see the VAR block's note on which one
    // to back off if a layer ever forms ragged (the row former, never the infeed)
    expect(p.get('Infeed')).toBe(1)
    expect(p.get('RowForm')).toBe(1)
    expect(p.get('ShiftSpeed')).toBe(0) // the chains sit below the roller line and only drive during a push
    expect(p.get('RunLamp')).toBe(true)

    step({ Stop: false }) // normally-closed Stop opens
    expect(p.get('running')).toBe(false)
    expect(p.get('Infeed')).toBe(0)
    expect(p.get('RowForm')).toBe(0)
    expect(p.get('ShiftSpeed')).toBe(0)
    expect(p.get('RunLamp')).toBe(false)
    expect(p.get('Tower')).toBe(0) // dark: red is the emergency colour, and a normal Stop is not one

    step({ Stop: true }) // released: no auto-restart after a manual stop
    expect(p.get('running')).toBe(false)
    step({ Start: true })
    expect(p.get('running')).toBe(true)

    // the E-stop breaks the same latch: struck, the line drops; twisted out, it stays down until a Start
    step({ Start: false, EStop: false })
    expect(p.get('running')).toBe(false)
    expect(p.get('Infeed')).toBe(0)
    expect(p.get('Tower')).toBe(4) // red, and only red
    step({ Start: true }) // Start cannot override a struck E-stop
    expect(p.get('running')).toBe(false)
    step({ Start: false, EStop: true })
    expect(p.get('running')).toBe(false)
    step({ Start: true })
    expect(p.get('running')).toBe(true)
  })

  // The E-stops are one chain: whichever is struck, the line drops, the tower goes red, the flex in the trailer stops,
  // and a Start does nothing until that one is twisted out again
  it('stops the whole line, flex included, from any one of its E-stops', () => {
    const { p, step } = runner()
    step()
    expect(p.get('FlexRun')).toBe(true)
    for (const tag of ESTOPS) {
      step({ Start: false, [tag]: false })
      expect(p.get('running'), tag).toBe(false)
      expect(p.get('FlexRun'), tag).toBe(false)
      expect(p.get('Infeed'), tag).toBe(0)
      expect(p.get('Tower'), tag).toBe(4)
      step({ Start: true })
      expect(p.get('running'), `${tag}: Start overrides a struck E-stop`).toBe(false)
      step({ Start: false, [tag]: true })
      expect(p.get('FlexRun'), tag).toBe(true) // released: the flex may run again...
      expect(p.get('running'), tag).toBe(false) // ...but the line waits for a Start
      step({ Start: true })
      expect(p.get('running'), tag).toBe(true)
    }
  })

  // The Start lamp says what the line is waiting for: steady while it runs, flashing while a trip left it down and a
  // Start would bring it back, dark while something still holds it down (a struck E-stop, a broken beam) and dark
  // after an operator Stop, which is not a trip: the line is down on purpose
  it('flashes the Start lamp while a tripped line waits for a Start, and only then', () => {
    const { p, step } = runner()
    const lamp = (inputs: Record<string, boolean>, scans: number): Set<unknown> => {
      const seen = new Set<unknown>()
      for (let i = 0; i < scans; i++) {
        step(inputs)
        seen.add(p.get('StartLamp'))
      }
      return seen
    }
    expect(lamp({}, 30)).toEqual(new Set([true])) // running: steady
    expect(lamp({ Stop: false }, 30)).toEqual(new Set([false])) // Stop held in: Start would do nothing
    expect(lamp({ Stop: true }, 30)).toEqual(new Set([false])) // released: stopped on purpose, not a trip
    step({ Start: true })
    step({ Start: false })
    expect(lamp({ EStop: false }, 30)).toEqual(new Set([false])) // struck
    expect(lamp({ EStop: true }, 30)).toEqual(new Set([true, false])) // twisted out: waiting for a Start
    step({ Start: true })
    step({ Start: false })
    expect(lamp({ OutCurtain: false }, 30)).toEqual(new Set([false])) // tripped, beam still broken
    expect(lamp({ OutCurtain: true }, 30)).toEqual(new Set([true, false])) // clear: waiting for a Start
    expect(lamp({ Start: true }, 30)).toEqual(new Set([true])) // and a Start ends it
    step({ Start: false })
    expect(lamp({ Guard: false }, 30)).toEqual(new Set([false])) // the gate opened under a running line
    expect(lamp({ Guard: true }, 30)).toEqual(new Set([true, false])) // closed: waiting for a Start
    step({ Start: true })
    step({ Start: false })
    // a line already stopped on purpose stays dark whatever happens to it: a beam broken or the gate opened while it
    // stands is no trip, so nothing asks for attention once they clear
    expect(lamp({ Stop: false }, 5)).toEqual(new Set([false]))
    expect(lamp({ Stop: true }, 5)).toEqual(new Set([false]))
    expect(lamp({ OutCurtain: false, Guard: false }, 30)).toEqual(new Set([false]))
    expect(lamp({ OutCurtain: true, Guard: true }, 30)).toEqual(new Set([false]))
    expect(p.get('tripped')).toBe(false)
  })

  // The E-stop is the push button with its mushroom head on, and that setting is what makes it one: it latches
  // and it is normally closed whatever the button's own two switches say, so the scene need not (and does not)
  // set them
  it('stands an emergency stop at the operator station, beside Start and Stop', () => {
    const parts = createPlcDemoScene().parts
    const btns = byPkg(parts, 'oip.push-button')
    const estop = btns.find((b) => paramsOf(b).tag === 'EStop')!
    expect(paramsOf(estop).emergencyStop).toBe(true)
    expect(estop.position[2]).toBeCloseTo(btns.find((b) => paramsOf(b).tag === 'Stop')!.position[2]!, 9)
  })

  // ...and one at every other place a person works the line, each bolted to steel that is really there: a fence post
  // on the outside of the guarding (a post, not mesh, at a standing hand's height), or the flex's load-end leg in the
  // trailer. Every one is wired, and none stands where a truck drives or the gate swings.
  it('puts an E-stop within reach of every work position, each on steel, clear of the trucks and the gate', () => {
    const parts = createPlcDemoScene().parts
    const byTag = (tag: string) => byPkg(parts, 'oip.push-button').filter((b) => paramsOf(b).tag === tag)
    for (const tag of ESTOPS) {
      expect(byTag(tag), tag).toHaveLength(1)
      expect(paramsOf(byTag(tag)[0]!).emergencyStop, tag).toBe(true)
    }
    const at = (tag: string) => byTag(tag)[0]!
    const parentName = (q: PartInstance) => parts.find((g) => g.id === q.parent)?.name
    expect(parentName(at('EStopDock'))).toBe('Trailer flex')
    expect(parentName(at('EStopGate'))).toBe('Cell fence 8')
    expect(parentName(at('EStopSupply'))).toBe('Cell fence 4')
    expect(parentName(at('EStopOutfeed'))).toBe('Cell fence 2')

    // the fence ones: the back plate (0.0317 behind the origin) on the outer face of a post of the fence run behind
    // it, its face looking away from the cell, the head (0.045 over the base) at 1.1 m
    const fences = parts.filter((q) => pkgId(q) === 'oip.fence')
    const postsOf = (f: PartInstance): [number, number][] => {
      const len = paramsOf(f).length as number
      const n = Math.ceil(len / 1.5) // examples/parts/fence MAX_SPACING
      const r = (f as { rotationY?: number }).rotationY ?? 0
      return Array.from({ length: n + 1 }, (_, k) => {
        const a = -len / 2 + (k * len) / n
        return [f.position[0] + a * Math.cos(r), f.position[2] - a * Math.sin(r)] as [number, number]
      })
    }
    const cellMid = [(2.0 + 8.5) / 2, -2.5]
    for (const tag of ['EStopGate', 'EStopSupply', 'EStopOutfeed']) {
      const b = at(tag)
      const ry = (b as { rotationY?: number }).rotationY ?? 0
      const face = [Math.sin(ry), Math.cos(ry)]
      const plate = [b.position[0] - face[0]! * 0.0317, b.position[2] - face[1]! * 0.0317]
      const post = fences.flatMap(postsOf).find((q) => Math.hypot(q[0] - plate[0]! + face[0]! * 0.03, q[1] - plate[1]! + face[1]! * 0.03) < 1e-6)
      expect(post, `${tag} sits on a fence post`).toBeDefined()
      // outward: the face points away from the middle of the cell
      expect(face[0]! * (b.position[0] - cellMid[0]!) + face[1]! * (b.position[2] - cellMid[1]!), tag).toBeGreaterThan(0)
      expect(b.position[1] + 0.045, tag).toBeCloseTo(1.1, 6)
    }
    // the gate's: east of the latch, so the leaf (1.1 m, swinging out from its hinge at the west end) never reaches it
    const gate = parts.find((q) => pkgId(q) === 'oip.safety-gate')!
    const gateLen = paramsOf(gate).length as number
    expect(at('EStopGate').position[0] - 0.045).toBeGreaterThan(gate.position[0] + gateLen / 2)

    // the trailer's: on the flex's load-end leg (the flex's origin; legs at hw + 0.06, 44 mm square), within an arm's
    // reach of where the cases go on
    const flex = parts.find((q) => pkgId(q) === 'oip.flex-conveyor')!
    const dock = at('EStopDock')
    expect(dock.position[0]).toBeCloseTo(flex.position[0], 9)
    expect(dock.position[2] - 0.0317).toBeCloseTo(flex.position[2] + (paramsOf(flex).width as number) / 2 + 0.06 + 0.022, 9)
    const source = parts.find((q) => pkgId(q) === 'oip.box-spawner')!
    expect(Math.hypot(source.position[0] - dock.position[0], source.position[2] - dock.position[2])).toBeLessThan(1.5)

    // none on a truck's road: every route leg passes each E-stop with a loaded truck's half-width (the 1.22 m load
    // across its blades, the widest thing it carries) plus 0.3 m to spare
    for (const route of [RACK_ROUTE, SUPPLY_ROUTE]) {
      for (let i = 1; i < route.length; i++) {
        const [ax, az] = [route[i - 1]![0]!, route[i - 1]![1]!]
        const [bx, bz] = [route[i]![0]!, route[i]![1]!]
        for (const tag of ESTOPS) {
          const [px, pz] = [at(tag).position[0], at(tag).position[2]]
          const [vx, vz] = [bx - ax, bz - az]
          const L = vx * vx + vz * vz
          const t = L < 1e-12 ? 0 : Math.max(0, Math.min(1, ((px - ax) * vx + (pz - az) * vz) / L))
          const d = Math.hypot(px - (ax + t * vx), pz - (az + t * vz))
          expect(d, `${tag} is ${d.toFixed(2)} m off a truck's path`).toBeGreaterThan(0.61 + 0.3 + 0.045)
        }
      }
    }
  })

  it('releases exactly one row of cases at a time: 2 for the straight row, 3 for the turned one', () => {
    const { p, step, sendCase, pushRow } = runner()
    step()
    expect(p.get('rowTarget')).toBe(2) // the straight row comes first
    expect(p.get('SpawnRun')).toBe(true)
    sendCase()
    expect(p.get('SpawnRun')).toBe(true) // one more to go
    sendCase()
    expect(p.get('SpawnRun')).toBe(false) // the row is released; hold until it has been pushed aside
    pushRow()
    expect(p.get('rowTarget')).toBe(3) // now the turned row
    expect(p.get('SpawnRun')).toBe(true)
  })

  // The plow is a fixed obstruction, not a kick: it is driven out and held there for every case of the turned row,
  // so each one runs into the same blade at the same place. Nothing is timed, which is what makes the turn
  // repeatable - there is no jab to land early or late.
  it('holds the plow extended for the whole turned row', () => {
    const { p, step, sendCase, pushRow } = runner()
    step()
    expect(p.get('rowPhase')).toBe(0)
    expect(p.get('Turn')).toBe(false) // retracted for the straight row

    sendCase()
    sendCase()
    pushRow()
    expect(p.get('rowPhase')).toBe(1)
    expect(p.get('Turn')).toBe(true) // out before the first turned case is released…
    for (let i = 0; i < 3; i++) {
      sendCase()
      step({}, 10)
      expect(p.get('Turn')).toBe(true) // …and it never drops mid-row
    }
  })

  it('keeps the plow retracted for every case of the straight row', () => {
    const { p, step, runWhile, sendCase } = runner()
    step()
    expect(p.get('rowPhase')).toBe(0)
    sendCase()
    expect(runWhile(40, 'Turn')).toBe(false)
    sendCase()
    expect(runWhile(40, 'Turn')).toBe(false)
  })

  // Both rows are pushed: the first across to the layer stop, the second into the back of it. That second push is
  // what squares the layer - a turned case does not come to rest where it formed, since pivoting against the plow
  // carries it off the lane, so left alone the second row would sit skewed with a gap.
  it('pushes both rows: the first to the layer stop, the second up against it', () => {
    const { p, step, sendCase, pushRow, runWhile } = runner()
    step()
    sendCase()
    sendCase()
    // the row-complete eye alone is not enough - the program waits for the whole row to have been released
    step({ RowReady: true })
    expect(p.get('rowPhase')).toBe(0)
    pushRow()
    expect(p.get('rowPhase')).toBe(1)
    expect(p.get('rowSent')).toBe(0)

    expect(p.get('rowsPushed')).toBe(1)
    // the turned row packs, and is pushed too - that second push is what closes the layer up
    for (let i = 0; i < 3; i++) sendCase()
    pushRow()
    expect(p.get('rowsPushed')).toBe(2)
    // both rows pushed and the far one parked on the stop: the layer is whole and the arm takes it
    runWhile(4)
    expect(p.get('picking')).toBe(true)
  })

  // The changeover - plow out, next row released - need not wait for the push to finish (2 s of dead lane
  // time): the deck is only told to move once the row is
  // packed on the stop, and a packed row is one whose every case is 3.4 m downstream of the plow. So at that
  // instant nothing is between the drop point and the blade, which is the only thing the hold was protecting.
  it('changes the plow over and starts the next row with the push, not after it', () => {
    const { p, step, sendCase } = runner()
    step()
    sendCase()
    sendCase()
    expect(p.get('SpawnRun')).toBe(false) // the straight row is out; nothing more until it is dealt with
    for (let i = 0; i < 30 && p.get('Shift') !== true; i++) step({ RowReady: true })
    expect(p.get('Shift')).toBe(true) // the push is commanded…
    expect(p.get('rowPhase')).toBe(1) // …and the line has already moved on to the turned row
    expect(p.get('rowSent')).toBe(0)
    expect(p.get('SpawnRun')).toBe(true)
    step()
    expect(p.get('Turn')).toBe(true) // the plow drives out while the deck is still crossing
    expect(p.get('rowTarget')).toBe(3)

    // a case released during the push belongs to the new row, and the end of the pulse must not wipe it - clearing
    // the count twice (once at the start, once at the end) formed the next row one case short
    sendCase()
    expect(p.get('rowSent')).toBe(1)
    for (let i = 0; i < 40 && p.get('Shift') === true; i++) step()
    expect(p.get('Shift')).toBe(false)
    expect(p.get('rowsPushed')).toBe(1)
    expect(p.get('rowSent')).toBe(1)
  })

  // ...but only the first push. After the second the layer is finished and standing on the lane, so there is
  // nowhere to put another row: the count is left standing and the spawner stays held until the arm has taken it.
  it('does not restart the spawner on the second push - a finished layer has nowhere to put another row', () => {
    const r = runner()
    const { p, step, sendCase, pushRow } = r
    step()
    sendCase()
    sendCase()
    pushRow()
    for (let i = 0; i < 3; i++) sendCase()
    expect(p.get('SpawnRun')).toBe(false)
    for (let i = 0; i < 30 && p.get('Shift') !== true; i++) step({ RowReady: true })
    expect(p.get('Shift')).toBe(true)
    expect(p.get('rowPhase')).toBe(1) // no changeover: this row completes the layer
    expect(p.get('rowSent')).toBe(3)
    expect(p.get('SpawnRun')).toBe(false)
  })

  it('needs both rows pushed and the far one parked on the layer stop before the layer counts as whole', () => {
    const { p, step, sendCase, pushRow } = runner()
    step()
    sendCase()
    sendCase()
    pushRow()
    expect(p.get('rowsPushed')).toBe(1)
    expect(p.get('layerDone')).toBe(false) // one row across is not a layer
    for (let i = 0; i < 3; i++) sendCase()
    // both rows pushed, but pretend the parked row never reached the layer stop
    step({ LayerReady: false })
    pushRow()
    step({ LayerReady: false })
    expect(p.get('rowsPushed')).toBe(2)
    expect(p.get('layerDone')).toBe(false)
    step({ LayerReady: true })
    expect(p.get('layerDone')).toBe(true)
  })

  it('waits for the row-complete eye before pushing, even once every case has been released', () => {
    const { p, step, sendCase } = runner()
    step()
    sendCase()
    sendCase()
    expect(p.get('rowSent')).toBe(2)
    step({}, 20) // the eye stays clear: the row has not packed against the stop yet
    expect(p.get('Shift')).toBe(false)
    step({ RowReady: true }, 18)
    expect(p.get('Shift')).toBe(true)
  })

  /** Build a whole layer: two rows, each released, packed and pushed. The row sizes are read off the program
   *  rather than hard-coded, because courses alternate which row is the turned one (3 cases) and which is the
   *  straight one (2) - that alternation is how the line builds the interlock. */
  function formLayer(r: ReturnType<typeof runner>): void {
    for (let row = 0; row < 2; row++) {
      const target = r.p.get('rowTarget') as number
      for (let i = 0; i < target; i++) r.sendCase()
      r.pushRow()
    }
    r.runWhile(3)
  }

  // The robot runs its own jobs (examples/parts/six-axis-robot, the palletizer's in demoScenes PALLETIZER_JOBS), so the
  // program's side of the arm is two commands and a handshake: job 1 picks the layer, job 2 + n places course n. Each
  // job is over when ArmIdle drops and comes back.
  const runJob = (step: ReturnType<typeof runner>['step']): void => {
    step({ ArmIdle: false }, 2)
    step({ ArmIdle: true }, 2)
  }

  it('runs the arm pick and place jobs once a layer is complete, and stops the rollers while it picks', () => {
    const r = runner()
    const { p, step } = r
    step()
    formLayer(r)
    expect(p.get('ArmCmd')).toBe(1) // the pick job
    expect(p.get('ArmExec')).toBe(true)
    expect(p.get('picking')).toBe(true)
    // a running surface would drag the layer out from under the vacuum - both are parked, which is the one time
    // braking is what we want
    expect(p.get('ShiftSpeed')).toBe(0)
    expect(p.get('RowForm')).toBe(0)
    expect(p.get('Infeed')).toBe(0)
    expect(p.get('SpawnRun')).toBe(false)

    runJob(step) // the layer is picked and lifted clear
    expect(p.get('ArmCmd')).toBe(2) // place it as course 1
    expect(p.get('ArmExec')).toBe(true)
    runJob(step) // placed, and the arm is home
    expect(p.get('Step')).toBe(0)
    expect(p.get('layerIdx')).toBe(1)
    // the lane is clear and the next layer starts back on the straight row
    expect(p.get('rowPhase')).toBe(0)
    expect(p.get('rowSent')).toBe(0)
    expect(p.get('picking')).toBe(false)
    step({ RowReady: false, LayerReady: false })
    expect(p.get('Infeed')).toBe(1)
  })

  // The robot's own Enable is the cell's safety: open the guard and the arm brakes where it is, mid-job, rather than
  // at the next step the program would have taken. Closing it again does not move the robot: that takes a Start.
  it('enables the robot only while the cell is safe', () => {
    const { p, step } = runner()
    step()
    expect(p.get('ArmEnable')).toBe(true)
    step({ Guard: false })
    expect(p.get('ArmEnable')).toBe(false)
    step({ Guard: true })
    expect(p.get('ArmEnable')).toBe(false)
    step({ Start: true })
    step({ Start: false })
    expect(p.get('ArmEnable')).toBe(true)
  })

  // The wrapper, the dispenser and the turntable are held like the robot: a Stop or a trip drops their enable mid-cycle
  // and only a Start brings it back, so releasing the Stop or the E-stop, or closing the guard, never restarts them.
  it('enables the wrapper, the dispenser and the turntable only while the line runs, until a Start', () => {
    const { p, step } = runner()
    step()
    expect(p.get('CycleEnable')).toBe(true)
    for (const tag of ['Stop', 'EStopOutfeed', 'EStopSupply', 'Guard', 'OutCurtain']) {
      step({ [tag]: false })
      expect(p.get('CycleEnable')).toBe(false)
      step({ [tag]: true }, 5) // released: still held, waiting for a Start
      expect(p.get('CycleEnable')).toBe(false)
      step({ Start: true })
      step({ Start: false })
      expect(p.get('CycleEnable')).toBe(true)
    }
  })

  // What holds the line during a pick is that a running surface would drag the layer out from under the vacuum -
  // and that stops being true the moment the plate has lifted it clear of the bed. So the release belongs at the
  // lift, not at the end of the cycle: the place, the retreat and the move home then overlap with the ~5.5 s the
  // next row's first case needs merely to reach the bed, and the whole leg costs the line nothing. The pick job
  // ends at the lift for exactly this reason (it blends through the apex, so it reports done on the way up).
  it('releases the line the moment the layer is lifted clear, not when the arm has finished placing it', () => {
    const r = runner()
    const { p, step } = r
    step()
    formLayer(r)
    expect(p.get('picking')).toBe(true)
    step({ ArmIdle: false }, 2) // the pick job is under way
    expect(p.get('picking')).toBe(true) // the bed stays parked until the plate is actually clear
    step({ ArmIdle: true }, 2) // the pick job is done: the layer is airborne

    expect(p.get('ArmCmd')).toBe(2) // away to the pallet, still carrying it
    expect(p.get('picking')).toBe(false) // ...and the line is already running behind it
    expect(p.get('rowPhase')).toBe(0)
    expect(p.get('rowSent')).toBe(0)
    expect(p.get('rowsPushed')).toBe(0)
    expect(p.get('layerIdx')).toBe(1) // the course the line is building, advanced with the release
    step({ RowReady: false, LayerReady: false })
    expect(p.get('Infeed')).toBe(1)
    expect(p.get('RowForm')).toBe(1)
    expect(p.get('SpawnRun')).toBe(true)
  })

  it('lays the three courses as jobs 2, 3, 4 - the middle one being the interlock pose', () => {
    const r = runner()
    const { p, step, runWhile } = r
    step()
    const courses: number[] = []
    for (let c = 0; c < 3; c++) {
      formLayer(r)
      // run the arm cycle to completion, recording the place job it ran
      for (let i = 0; i < 40; i++) {
        step({ ArmIdle: false })
        step({ ArmIdle: true }, 2)
        const cmd = p.get('ArmCmd') as number
        if (cmd >= 2 && cmd <= 4 && !courses.includes(cmd)) courses.push(cmd)
        if (p.get('Step') === 0) break // back at rest - a finished load goes to OutStep now, never to Step
      }
      step({ RowReady: false, LayerReady: false })
      runWhile(4)
    }
    expect(courses).toEqual([2, 3, 4])
  })

  // Lay all three courses so the load is finished and the cell is sitting at the discharge step.
  const fillPallet = (r: ReturnType<typeof runner>): void => {
    const { p, step, runWhile } = r
    for (let c = 0; c < 3; c++) {
      formLayer(r)
      for (let i = 0; i < 40; i++) {
        step({ ArmIdle: false })
        step({ ArmIdle: true }, 2)
        if (p.get('Step') === 0) break // back at rest - a finished load goes to OutStep now, never to Step
      }
      step({ RowReady: false, LayerReady: false })
      runWhile(4)
    }
  }

  // The finished load leaves on the line now, not in a truck's forks. What this pins is the handshake that makes
  // that safe: the deck is square with the line before anything drives onto it, the line stops dead once the load
  // is ON the turntable, and the lane only drives once the deck has finished indexing. Convey through a slew and
  // the deck turns under the load.
  it('sends the finished load out through the turntable onto a staging lane, then drops a fresh pallet', () => {
    const r = runner()
    const { p, step, runWhile } = r
    step()
    fillPallet(r)
    expect(p.get('palletFull')).toBe(true)
    // a pallet change is automatic, so the tower stays green through it: amber is for a load with nowhere to go
    expect(p.get('Tower')).toBe(1)
    expect(p.get('RunLamp')).toBe(true)
    // The case line keeps running through the pallet change: the two halves of the cell are independent, so the
    // next layer builds while the finished load is on its way out. What stops the spawner is a finished layer
    // standing on the lane with nowhere to go, not the change itself.
    expect(p.get('SpawnRun')).toBe(true)

    // squared with the line first, THEN the build deck and the outfeed drive the load onto the deck
    runWhile(6, undefined, () => p.get('outRun') === true)
    expect(p.get('TurnCmd')).toBe(0)
    expect(p.get('PalletOut')).toBe(real(0.4))
    expect(p.get('TurnRun')).toBe(real(0.4))
    expect(p.get('Lane')).toBe(0) // nothing downstream drives while the load is still coming on

    // into the stretch wrapper: its station eye stops the load under the arm, and one edge starts the wrap...
    runWhile(100, undefined, () => p.get('WrapStart') === true)
    expect(p.get('OutStep')).toBe(107)
    expect(p.get('PalletOut')).toBe(0)
    expect(p.get('TurnRun')).toBe(0)
    // ...and the load goes on only once the wrapper says it is wrapped and its arm is parked
    step({}, 100)
    expect(p.get('OutStep')).toBe(107)
    expect(p.get('PalletOut')).toBe(0)
    r.wrapOut()
    expect(p.get('WrapStart')).toBe(false)
    expect(p.get('PalletOut')).toBe(real(0.4))

    // on the deck: the line stops rather than pushing it across and off
    step({ TurnEye: true }, 2)
    expect(p.get('PalletOut')).toBe(0)
    // it settles, the deck turns a quarter to face the lane, and only then does the lane drive
    runWhile(20, undefined, () => p.get('TurnCmd') === real(-90))
    expect(p.get('TurnCmd')).toBe(-90)
    runWhile(4, undefined, () => p.get('laneRun') === true)
    expect(p.get('Lane')).toBe(real(0.4))

    // staged: the lane stops, and the rack truck is dispatched off the lane rather than off the cell's sequence.
    // Its first command is its first corner: the truck parks at the far end of the rack aisle, so a trip leaves
    // along it (RACK_WAYS.out corners) before it reaches the pick.
    step({ LaneFull: true }, 2)
    expect(p.get('Lane')).toBe(0)
    expect(RACK_WAYS.out).toBe(1)
    runWhile(4, undefined, () => p.get('RackCmd') !== 0)
    expect(p.get('RackCmd')).toBe(AGV_WAY_BASE)

    // a fresh pallet drops and the cell is ready for the next load
    runWhile(20, undefined, () => p.get('palletFull') === false)
    expect(p.get('palletFull')).toBe(false)
    expect(p.get('PalletFeed')).toBe(false)
    expect(p.get('layerIdx')).toBe(0)
    expect(p.get('Step')).toBe(0)
    expect(p.get('SpawnRun')).toBe(true)
  })

  // The turntable's handshake: it must not index under a load still coasting onto it, and the lane must not drive
  // until the slew is done.
  it('indexes the turntable a quarter turn to the lane only once the load has settled on it', () => {
    const r = runner()
    const { p, step, runWhile } = r
    step()
    fillPallet(r)
    runWhile(6, undefined, () => p.get('outRun') === true)
    expect(p.get('TurnCmd')).toBe(0) // square with the line to RECEIVE
    r.wrapOut()
    step({ TurnEye: true, TurnDone: false }, 3)
    // the eye trips while the load is still coasting onto the plate (measured in the running cell: the
    // pallet at 0.27 m/s, the cases on top at 0.39 m/s). Turning the platter under a sliding load leaves
    // it skewed by whatever momentum was left, so the deck holds still until it has settled - the drive
    // is already off (outRun dropped with the eye), this is the cell waiting for physics.
    expect(p.get('TurnCmd')).toBe(0) // NOT commanded yet, three scans in
    expect(p.get('OutStep')).toBe(115) // ...it is sitting in the settle dwell
    runWhile(20, undefined, () => p.get('TurnCmd') === real(-90))
    expect(p.get('TurnCmd')).toBe(-90) // now indexed across to the lane
    expect(p.get('Lane')).toBe(0) // and nothing drives while it is slewing...
    expect(p.get('TurnRun')).toBe(0)

    step({ TurnDone: true }, 2) // ...only once the deck has arrived
    runWhile(4, undefined, () => p.get('laneRun') === true)
    expect(p.get('Lane')).toBe(real(0.4))

    step({ LaneFull: true }, 2)
    expect(p.get('TruckStep') as number).toBeGreaterThan(0) // the truck is dispatched to it
    expect(p.get('TurnCmd')).toBe(0) // deck squared back up for the next load
  })

  // The discharge route holds no robot, so the arm is free to build while a load leaves: the outfeed has its own
  // dispatcher, and the fresh pallet is fed as soon as the build deck comes free (an eye just past the deck's end
  // says so), not when the load reaches the turntable, and the deck stops while the outfeed carries the load on.
  it('feeds the next pallet as soon as the deck is clear, so the cell builds while the load is still leaving', () => {
    const r = runner()
    const { p, step, runWhile } = r
    step()
    fillPallet(r)
    expect(p.get('palletFull')).toBe(true)
    expect(p.get('OutStep') as number).toBeGreaterThanOrEqual(100) // the outfeed has the load, already running…
    expect(p.get('Step')).toBe(0) //                                  …and the arm is back on the line, not in it

    runWhile(6, undefined, () => p.get('outRun') === true)
    step({}, 3) // the load passes the off-deck eye and clears it - the build deck is empty from this scan
    expect(p.get('PalletFeed')).toBe(true) // so the next pallet comes in now, before the load is even on the turntable
    expect(p.get('DeckRun')).toBe(0) //       the deck it lands on has stopped…
    expect(p.get('PalletOut')).toBe(real(0.4)) // …while the outfeed carries the load on
    r.wrapOut() //                                 (through the wrapper)
    step({ TurnEye: true }, 2)
    expect(p.get('OutStep')).toBe(115) //   …and the route carries on without waiting for the feed

    runWhile(20, undefined, () => p.get('palletFull') === false)
    expect(p.get('palletFull')).toBe(false) // a pallet is standing on the deck…
    expect(p.get('OutStep') as number).toBeGreaterThanOrEqual(115) // …while the load it replaced is still on
    expect(p.get('OutStep') as number).toBeLessThanOrEqual(130) //    its way to the lane

    // and that is the whole point: the next course is picked with the old load still on its way out
    formLayer(r)
    expect(p.get('picking')).toBe(true)
    expect(p.get('OutStep')).toBe(130)
  })

  // The lane still staged and the truck has not cleared it: the cell must wait rather than build a fourth course
  // onto a load it has nowhere to put.
  it('holds the finished load while the staging lane is occupied', () => {
    const r = runner()
    const { p, step, runWhile } = r
    step()
    step({ LaneFull: true }) // staged before this load is even finished
    fillPallet(r)
    step({}, 6)
    expect(p.get('OutStep')).toBe(100) // the outfeed is parked, waiting for the lane…
    expect(p.get('Step')).toBe(0) //      …and the arm is idle rather than parked inside the route
    expect(p.get('PalletOut')).toBe(0)
    expect(p.get('palletFull')).toBe(true) // no fresh pallet is fed while the finished one has nowhere to go
    expect(p.get('Tower')).toBe(1 | 2) // green AND amber: running, but the outfeed needs the lane cleared
    // Backpressure stops the pallet line, not the case line: the cell has nowhere to put this load, but it can
    // still build the next layer behind it. That buffers one layer and then holds itself, since a finished layer
    // waiting on the lane is what gates the spawner.
    expect(p.get('SpawnRun')).toBe(true)

    // the truck clears the lane and the load goes out
    step({ LaneFull: false }, 2)
    expect(p.get('Tower')).toBe(1) // amber clears the moment the lane does
    runWhile(6, undefined, () => p.get('outRun') === true)
    expect(p.get('outRun')).toBe(true)
  })

  // The scene ships a finished load on the build deck AND the program opens in its discharge step. Those two are
  // one decision: ship the load without the program state and the arm stacks a fourth course into the load
  // already standing there; set the state without the load and the cell conveys an empty deck to the racks.
  // Nothing links them at runtime, so this is the link.
  it('opens with a finished load already on the build deck, and a program that starts by shipping it', () => {
    const parts = createPlcDemoScene().parts
    const deckPallet = parts.find((q) => q.name === 'Build pallet')!
    const stack = parts.filter((q) => {
      const g = parts.find((r) => r.id === q.parent)
      return g?.name === 'Prestaged load' && pkgId(q) === 'oip.box'
    })
    expect(stack).toHaveLength(15) // three courses of five, the same pattern the cell builds
    // standing ON the build pallet, not beside it
    for (const b of stack) {
      expect(Math.abs(b.position[0]! - deckPallet.position[0]!)).toBeLessThan(0.7)
      expect(Math.abs(b.position[2]! - deckPallet.position[2]!)).toBeLessThan(0.7)
      expect(b.position[1]!).toBeGreaterThan(deckPallet.position[1]!)
    }

    // and the program agrees: full pallet, nothing built, the outfeed parked at the lane choice - and the arm
    // idle at 0, since what the scene ships is a load to send away, not one to pick
    const raw = compileDemo()
    expect(raw.get('palletFull')).toBe(true)
    expect(raw.get('OutStep')).toBe(100)
    expect(raw.get('Step')).toBe(0)
    // ...and layerIdx is 0, not 3: it counts courses onto the pallet being built. It also picks the row parity,
    // and the case line starts feeding immediately, so seeding it with the outgoing load's count lays the first
    // row of the first layer the wrong way round.
    expect(raw.get('layerIdx')).toBe(0)
  })

  // The very first row the cell releases has to be the straight one, because layer 1 is the canonical course and
  // its parity sets the whole interlocked stack. It is not obvious that this is at risk: the case line starts
  // feeding while the prestaged load is still being shipped out, so it reads the row parity off layerIdx before
  // the pallet change has finished resetting it. Seeded with the outgoing load's course count, the first row came
  // out turned and the reset then flipped the parity underneath it - two rows laid the same way round.
  it('releases the first row of the first layer straight, even though the line starts during the pallet change', () => {
    const raw = compileDemo()
    const set = (over: Record<string, boolean>): void => {
      for (const [k, v] of Object.entries({
        Start: false, Stop: true, Guard: true, BoxAtEye: false, RowReady: false, LayerReady: false,
        ArmIdle: true, TurnDone: true, TurnEye: false, LaneFull: false,
        RackIdle: true, SupplyIdle: true, ...over,
      })) raw.setInput(k, v as boolean)
      raw.scan(SCAN)
    }
    set({}) // first scan of a freshly loaded scene, still mid-discharge
    expect(raw.get('palletFull')).toBe(true) // the prestaged load has not left yet...
    expect(raw.get('SpawnRun')).toBe(true) //  ...and the case line is already feeding behind it
    expect(raw.get('turnedFirst')).toBe(false)
    expect(raw.get('thisRowTurned')).toBe(false)
    expect(raw.get('Turn')).toBe(false) // the plow stays retracted for a straight row
    expect(raw.get('rowTarget')).toBe(2) // two 0.6 m cases, not three turned ones
  })

  // ...and the same hazard on every load after the first, which the seeding above does not cover. A load closes
  // out with layerIdx at 3 (the third course just laid), and the case line immediately starts the next load's
  // first layer behind it - reading the parity off that 3. So the first row comes out turned, and when the change
  // finishes and resets layerIdx the parity flips underneath the half-built layer: the second row is formed turned
  // as well, and the layer the arm then picks as course 1 has both rows the same way round. The reset belongs
  // where the load is closed out, not where the change ends.
  it('releases the first row straight on every load, not just the first one', () => {
    const r = runner()
    const { p, step } = r
    step()
    fillPallet(r)
    expect(p.get('palletFull')).toBe(true) // the finished load is on its way out...
    expect(p.get('SpawnRun')).toBe(true) //   ...and the line is already feeding the next one behind it
    expect(p.get('layerIdx')).toBe(0) // the courses count for the load being built, and that one is empty
    expect(p.get('turnedFirst')).toBe(false)
    expect(p.get('thisRowTurned')).toBe(false)
    expect(p.get('Turn')).toBe(false)
    expect(p.get('rowTarget')).toBe(2)
  })

  // The parity must also not flip while that layer is half-built - a row is formed over several seconds and the
  // pallet change runs the whole time, so a reset landing between the two rows is exactly the failure above.
  it('holds the row parity steady across the whole pallet change', () => {
    const r = runner()
    const { p, step, runWhile } = r
    step()
    fillPallet(r)
    const parity = p.get('turnedFirst')
    // walk the discharge out to the fresh pallet, watching the parity the line is building to
    runWhile(6, undefined, () => p.get('outRun') === true)
    expect(p.get('turnedFirst')).toBe(parity)
    r.wrapOut()
    step({ TurnEye: true }, 2)
    runWhile(4, undefined, () => p.get('laneRun') === true)
    expect(p.get('turnedFirst')).toBe(parity)
    step({ LaneFull: true }, 2)
    runWhile(20, undefined, () => p.get('palletFull') === false)
    expect(p.get('palletFull')).toBe(false)
    // one more scan: turnedFirst is derived at the top of a scan, so a reset late in the change only shows up on
    // the next one - assert after it, or the flip this is here to catch slips through
    step()
    expect(p.get('turnedFirst')).toBe(parity) // the change ends without moving the parity under the line
  })

  // The deck must never be driving while the chains are down. They are not down only when the program says so:
  // the part slews the lift over 150 ms, so commanding rise and run in the same scan drives a powered surface
  // sideways underneath the roller line for the whole stroke - dragging at the row it is supposed to be lifting.
  it('does not drive the chain deck until the pop-up stroke has finished', () => {
    const r = runner()
    const { p, step, sendCase } = r
    step()
    sendCase() //  one straight row's worth - two 0.6 m cases
    sendCase()
    step({ RowReady: true })
    // catch the exact scan the push is commanded: the chains are told to rise...
    for (let i = 0; i < 30 && p.get('Shift') !== true; i++) step()
    expect(p.get('Shift')).toBe(true)
    expect(p.get('ShiftSpeed')).toBe(0) // ...and the deck is NOT yet driving
    // ...only once the stroke is out does it drive
    step({}, 3)
    expect(p.get('Shift')).toBe(true)
    expect(p.get('ShiftSpeed')).toBe(1)
    // coming down needs no delay: the speed drops in the same scan the chains do
    for (let i = 0; i < 40 && p.get('Shift') === true; i++) step()
    expect(p.get('Shift')).toBe(false)
    expect(p.get('ShiftSpeed')).toBe(0)
  })

  // Closing the gate must not by itself restart hazardous motion: it ends the trip, and the Start lamp flashes for the
  // Start that resumes the sequence where it stood.
  it('safety gate is a live interlock: opening it holds the arm and reds the tower, and only a Start resumes', () => {
    const r = runner()
    const { p, step } = r
    step()
    formLayer(r)
    expect(p.get('ArmCmd')).toBe(1)
    const stepAt = p.get('Step')

    step({ Guard: false }, 5) // the gate opens
    expect(p.get('safe')).toBe(false)
    expect(p.get('Step')).toBe(stepAt) // the sequence is frozen where it stood
    expect(p.get('Infeed')).toBe(0)
    expect(p.get('Turn')).toBe(false) // the plow retracts out of the lane
    expect(p.get('Shift')).toBe(false)
    expect(p.get('ShiftSpeed')).toBe(0)
    expect((p.get('Tower') as number) & 4).toBe(4) // red
    expect(p.get('RunLamp')).toBe(false)

    step({ Guard: true }, 2) // closed again: still stopped, and waiting for a Start
    expect(p.get('safe')).toBe(false)
    expect(p.get('RunLamp')).toBe(false)
    expect(p.get('Tower')).toBe(0)
    expect(p.get('ready')).toBe(true)
    expect(p.get('Step')).toBe(stepAt)

    step({ Start: true }) // ...and a Start picks up where it left off
    step({ Start: false })
    expect(p.get('safe')).toBe(true)
    expect(p.get('RunLamp')).toBe(true)
    expect(p.get('Step')).toBe(stepAt)
  })
})

// The demo ships one program in two languages: Palletizer in ladder, calling PalletTruck in Structured Text. Each has a
// twin in the other language (demoReference.ts), and the shipped program is held to being one machine with the demo
// all in Structured Text and all in ladder: every variable they share (their state, their trucks', every output) equal
// after every scan. Here on inputs chosen at random, which reach corners the cell's own run may not;
// demoScenesSim.test.ts holds the shipped program to it on that run, in lockstep with the physics.
describe('the demo in two languages (Palletizer in ladder, PalletTruck in ST)', () => {
  /** a seeded generator, so a failure replays */
  const mulberry32 = (seed: number) => (): number => {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  // three programs a scan, ~30 s: the timeout keeps its 3x margin for a loaded machine
  it('runs scan for scan the same as the demo all in ST and all in ladder, every shared variable, on inputs at random', { timeout: 90000 }, () => {
    const shipped = compile(runnableSource(DEMO_PROGRAM, DEMO_CONTROLLER))
    const st = compile(runnableSource(DEMO_REFERENCE_PROGRAM, ST_REFERENCE_CONTROLLER))
    const ld = compile(runnableSource(DEMO_REFERENCE_PROGRAM, LADDER_REFERENCE_CONTROLLER))
    const shared = Object.keys(st.watch).filter((k) => k in shipped.watch && k in ld.watch)
    // the comparison covers the machine, not just its I/O: its steps and counts, each truck as its block shows it, the
    // timers (a block's own variables are not in the watch, so the trucks are held by what they put out)
    for (const k of ['Main.Step', 'Main.OutStep', 'Main.layerIdx', 'Main.Truck.Step', 'Main.Truck.Want', 'Main.RowPacked.ET', 'Tower', 'RackCmd', 'SupplyCmd', 'Main.S3Step']) expect(shared).toContain(k)
    expect(shared.length).toBeGreaterThan(90)
    // sticky inputs, each flipping now and then; Stop, the E-stop and Guard mostly closed, so the line gets somewhere
    const flip: Record<string, number> = {
      Start: 0.05, Stop: 0.004, EStop: 0.004, EStopDock: 0.001, EStopGate: 0.001, EStopSupply: 0.001, EStopOutfeed: 0.001, Guard: 0.004, BoxAtEye: 0.3, RowReady: 0.08, LayerReady: 0.08, ArmIdle: 0.3,
      TurnDone: 0.2, TurnEye: 0.1, LaneFull: 0.05, RackIdle: 0.3, SupplyIdle: 0.3, PalletIn: 0.1, DispBusy: 0.2, PalletReady: 0.1,
      LoadOut: 0.1, CaseCurtain: 0.002, FeedCurtain: 0.002, OutCurtain: 0.002, WrapInPos: 0.1, WrapDone: 0.1, FlexFull: 0.1,
    }
    const inputs: Record<string, boolean> = { Start: false, Stop: true, EStop: true, EStopDock: true, EStopGate: true, EStopSupply: true, EStopOutfeed: true, Guard: true, BoxAtEye: false, RowReady: false, LayerReady: false, ArmIdle: true, TurnDone: true, TurnEye: false, LaneFull: false, RackIdle: true, SupplyIdle: true, PalletIn: false, DispBusy: false, PalletReady: false, LoadOut: false, CaseCurtain: true, FeedCurtain: true, OutCurtain: true, WrapInPos: false, WrapDone: false, FlexFull: false }
    // the curtains' muting eyes too, so the three programs are compared with muting starting and ending under them
    for (const o of ['Case', 'Feed', 'Out']) for (const pin of ['A1', 'A2']) {
      flip[`${o}Mute${pin}`] = 0.05
      inputs[`${o}Mute${pin}`] = false
    }
    const rand = mulberry32(20260919)
    const seen = { arm: new Set<unknown>(), out: new Set<unknown>(), truck: new Set<unknown>(), supply: new Set<unknown>() }
    for (let scan = 0; scan < 12000; scan++) {
      for (const k of Object.keys(inputs)) if (rand() < flip[k]!) inputs[k] = !inputs[k]
      // a stopped line comes back: a closed Stop and guard are the rule, not the exception
      if (!inputs['Stop'] && rand() < 0.2) inputs['Stop'] = true
      for (const e of ESTOPS) if (!inputs[e] && rand() < 0.2) inputs[e] = true
      if (!inputs['Guard'] && rand() < 0.2) inputs['Guard'] = true
      for (const c of ['CaseCurtain', 'FeedCurtain', 'OutCurtain']) if (!inputs[c] && rand() < 0.2) inputs[c] = true
      for (const [k, v] of Object.entries(inputs)) {
        shipped.setInput(k, v)
        st.setInput(k, v)
        ld.setInput(k, v)
      }
      // the dispenser's magazine: empty (the supply truck is sent) or stocked, a few hundred scans at a time
      const mag = Math.floor(scan / 300) % 3 === 0 ? 0 : 6
      for (const prog of [shipped, st, ld]) prog.setInput('MagLevel', mag)
      seen.supply.add(st.watch['Main.S3Step'])
      shipped.scan(SCAN)
      st.scan(SCAN)
      ld.scan(SCAN)
      const a = st.watch
      for (const [name, b] of [['shipped', shipped.watch], ['all-LD', ld.watch]] as const) {
        const differ = shared.filter((k) => a[k] !== b[k])
        if (differ.length > 0) {
          expect.fail(`scan ${scan}: ${differ.slice(0, 8).map((k) => `${k} all-ST ${String(a[k])} / ${name} ${String(b[k])}`).join(', ')}\ninputs ${JSON.stringify(inputs)}`)
        }
      }
      seen.arm.add(a['Main.Step'])
      seen.out.add(a['Main.OutStep'])
      seen.truck.add(a['Main.Truck.Step'])
    }
    // ...and the walk reached every step of all three machines, or it compared idle programs
    expect([...seen.arm].sort((x, y) => Number(x) - Number(y))).toEqual([0, 10, 20])
    expect([...seen.out].sort((x, y) => Number(x) - Number(y))).toEqual([0, 100, 105, 106, 107, 110, 115, 120, 130, 140])
    expect([...seen.truck].sort((x, y) => Number(x) - Number(y))).toEqual([0, 5, 6, 12, 14, 16, 20, 22, 24, 25, 30, 32, 40])
    // ...and the supply truck's dispatcher went out and loaded the dispenser (its pick, its load into the magazine)
    expect([...seen.supply]).toEqual(expect.arrayContaining([0, 12, 20, 24, 30, 40]))
  })

  it('is one ladder POU and one Structured Text one, and no rung of it carries an export caveat', () => {
    const ast = parse(lex(runnableSource(DEMO_PROGRAM, DEMO_CONTROLLER)))
    // the program is one section that is its whole body, what exports as a PLCopen <LD> body; the truck block has none,
    // so no POU mixes the two (which is what keeps the PLC panel's Text/Ladder switch away from the demo)
    expect(ast.ladder.map((s) => [s.pou, s.whole])).toEqual([['Palletizer', true]])
    expect(ast.ladder.flatMap(ladderExportCaveats)).toEqual([])
  })

  it('keeps its all-ladder twin free of export caveats too', () => {
    const ast = parse(lex(runnableSource(DEMO_REFERENCE_PROGRAM, LADDER_REFERENCE_CONTROLLER)))
    const twin = ast.ladder.filter((s) => s.pou === 'PalletTruckLD' || s.pou === 'PalletizerLD')
    expect(twin.map((s) => [s.pou, s.whole])).toEqual([
      ['PalletTruckLD', true],
      ['PalletizerLD', true],
    ])
    expect(twin.flatMap(ladderExportCaveats)).toEqual([])
  })
})
