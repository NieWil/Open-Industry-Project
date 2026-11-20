import type { PackageManifest } from '../core/parts/partPackage'
import initJolt from 'jolt-physics'
import { describe, expect, it } from 'vitest'
import { CARGO_KIND_BOX, CARGO_KIND_PALLET } from '../core/frame'
import { quatFromYXZ } from '../core/math'
import { PALLET_SIZE, SCENE_VERSION, DEFAULT_SIM_HZ } from '../core/types'
import type { BuildingPart, SdkPart, PartInstance, SceneJSON } from '../core/types'
import type { PartAsset, PartMaterial, PartPackage, PartPackageGeometry } from '../core/parts/partPackage'
import { createSdkPart } from '../core/scene/scene'
import { clearPartDiagnostics, partDiagnosticsFor } from '../core/parts/partDiagnostics'
import { registerPackage, unregisterPackage } from '../core/parts/partRegistry'
import { buildPackage } from './buildPackage'
import { SimWorld } from './world'

const Jolt = await initJolt()
const SLOW = { timeout: 60000 }

// The Roller / Belt conveyors are custom parts (examples/parts/{roller-conveyor,belt-conveyor}); the conveyor
// physics themselves are covered by sdkConveyorParity + the render *RigParity tests. Here we register the committed
// sources so the generic sim-machinery tests below (freeze / pilot / live-edit / cargo / guards /
// lifecycle) can sit cargo on a real conveyor, exactly as the app builds them.
const RIGS = import.meta.glob('../../examples/parts/*/rig.json', { eager: true, import: 'default' }) as Record<
  string,
  { id: string; name: string; geometry: PartPackageGeometry; materials?: PartMaterial[]; assets?: PartAsset[] }
>
const BEHAVIORS = import.meta.glob('../../examples/parts/*/behavior.ts', { eager: true, query: '?raw', import: 'default' }) as Record<string, string>
function loadPkg(dir: string): PartPackage {
  const manifest = RIGS[`../../examples/parts/${dir}/rig.json`]
  const behavior = BEHAVIORS[`../../examples/parts/${dir}/behavior.ts`]
  if (!manifest || behavior === undefined) throw new Error(`no committed part at examples/parts/${dir}`)
  const pkg = buildPackage(
    // assets too: a material's texture (the chain transfer's link photo) references one by id
    { id: manifest.id, name: manifest.name, geometry: manifest.geometry, ...(manifest.materials ? { materials: manifest.materials } : {}), ...((manifest as { conveyor?: PackageManifest['conveyor'] }).conveyor ? { conveyor: (manifest as { conveyor?: PackageManifest['conveyor'] }).conveyor } : {}), ...(manifest.assets ? { assets: manifest.assets } : {}) },
    behavior.replace(/\r\n/g, '\n'),
  )
  registerPackage(pkg)
  return pkg
}
const ROLLER_PKG = loadPkg('roller-conveyor')
const BELT_PKG = loadPkg('belt-conveyor')
// Cargo (box / pallet) is the SDK custom part oip.box / oip.pallet: a `custom` part whose package
// declares geometry.kind:'cargo'. The sim builds it as a dynamic cargo body via addSdkPart → cargoView.
// Register the committed sources so boxPart() / palletPart() below can sit real cargo in the world.
const BOX_PKG = loadPkg('box')
const PALLET_PKG = loadPkg('pallet')
const CHAIN_PKG = loadPkg('chain-transfer')
const DESPAWNER_PKG = loadPkg('despawner')

// These helpers take the bed centre as (x,z) for test convenience, then convert to the
// tail-origin position the engine expects (tail = centre - halfLength along forward), so a
// box dropped at the given centre still lands on the bed.
function tailPos(x: number, z: number, length: number, rotationY: number): [number, number] {
  const h = length / 2
  return [x - h * Math.cos(rotationY), z - h * -Math.sin(rotationY)]
}

// SDK Roller Conveyor (rig, centre origin): the position is the bed centre. Defaults are baked from the package; only the exercised params are overridden.
function roller(id: string, x: number, y: number, z: number, length: number, speed: number, rotationY = 0, guards = false): SdkPart {
  const p = createSdkPart(ROLLER_PKG, id, [x, y, z], rotationY)
  Object.assign(p.params, { length, width: 0.6, speed, leftGuard: guards, rightGuard: guards })
  return p
}

// SDK Belt Conveyor (function bed, tail origin): the position is the belt tail.
function belt(id: string, x: number, y: number, z: number, length: number, speed: number, rotationY = 0, guards = false): SdkPart {
  const [tx, tz] = tailPos(x, z, length, rotationY)
  const p = createSdkPart(BELT_PKG, id, [tx, y, tz], rotationY)
  Object.assign(p.params, { segments: [[length, 0]], width: 0.6, height: 0.5, speed, leftGuard: guards, rightGuard: guards, legs: false })
  return p
}

// SDK cargo (oip.box): a `custom` part whose package defaults bake the built-in box's 0.6 × 0.4 × 0.4 m, 10 kg
// white cargo. Position is the box centre (cargoView is centre-origin).
function boxPart(id: string, x: number, y: number, z: number, rotationY = 0): SdkPart {
  return createSdkPart(BOX_PKG, id, [x, y, z], rotationY)
}

// SDK cargo (oip.pallet): package defaults bake the fixed EUR-pallet size, 20 kg white - the built-in Pallet's params.
function palletPart(id: string, x: number, y: number, z: number, rotationY = 0): SdkPart {
  return createSdkPart(PALLET_PKG, id, [x, y, z], rotationY)
}

// SDK Chain Transfer (rig, centre origin): a right-angle transfer whose conveying deck rides the pop-up `lift`
// joint. `raised` seeds the pop-up state on the first step (no tween); `speed` drives the through/divert carry.
// The deck top sits at the part origin (y) when lowered, and pops ~0.095 m above it when raised.
function chainTransfer(id: string, x: number, y: number, z: number, opts: { raised: boolean; speed: number }): SdkPart {
  const p = createSdkPart(CHAIN_PKG, id, [x, y, z], 0)
  Object.assign(p.params, { raised: opts.raised, speed: opts.speed })
  return p
}

function scene(...parts: PartInstance[]): SceneJSON {
  return { version: SCENE_VERSION, parts }
}

function recordStep(world: SimWorld, xs: number[], ys: number[], zs?: number[]): void {
  world.step()
  const f = world.frame()
  expect(f.count).toBe(1)
  expect(f.kinds.length).toBe(1)
  for (let i = 0; i < 3; i++) expect(Number.isFinite(f.positions[i]!)).toBe(true)
  for (let i = 0; i < 4; i++) expect(Number.isFinite(f.quats[i]!)).toBe(true)
  xs.push(f.positions[0]!)
  ys.push(f.positions[1]!)
  zs?.push(f.positions[2]!)
}

describe('SimWorld conveying', () => {
  it('box accelerates to roller speed', () => {
    const world = new SimWorld(Jolt, scene(roller('c1', 0, 0.75, 0, 3, 0.5)))
    world.spawnBoxAt(-1.3, 0.97, 0, 0.15, 0.2, 0.15)
    const xs: number[] = []
    const ys: number[] = []
    for (let i = 0; i < 180; i++) recordStep(world, xs, ys)
    const vx = (xs[179]! - xs[149]!) * (DEFAULT_SIM_HZ / 30)
    expect(vx).toBeGreaterThan(0.4)
    expect(vx).toBeLessThan(0.6)
    expect(xs[179]!).toBeGreaterThan(xs[0]!)
    world.dispose()
  })

  it('reverse speed conveys -x', () => {
    const world = new SimWorld(Jolt, scene(roller('c1', 0, 0.75, 0, 3, -0.5)))
    world.spawnBoxAt(1.3, 0.97, 0, 0.15, 0.2, 0.15)
    const xs: number[] = []
    const ys: number[] = []
    for (let i = 0; i < 180; i++) recordStep(world, xs, ys)
    const vx = (xs[179]! - xs[149]!) * (DEFAULT_SIM_HZ / 30)
    expect(vx).toBeLessThan(-0.4)
    expect(vx).toBeGreaterThan(-0.6)
    expect(xs[179]!).toBeLessThan(xs[0]!)
    world.dispose()
  })

  it('belt conveys at belt speed', () => {
    const world = new SimWorld(Jolt, scene(belt('b1', 0, 0.75, 0, 3, 0.5)))
    world.spawnBoxAt(-1.3, 0.97, 0, 0.15, 0.2, 0.15)
    const xs: number[] = []
    const ys: number[] = []
    for (let i = 0; i < 180; i++) recordStep(world, xs, ys)
    const vx = (xs[179]! - xs[149]!) * (DEFAULT_SIM_HZ / 30)
    expect(vx).toBeGreaterThan(0.4)
    expect(vx).toBeLessThan(0.6)
    const bottom = ys[179]! - 0.2
    expect(bottom).toBeGreaterThan(0.75 - 0.06)
    expect(bottom).toBeLessThan(0.75 + 0.06)
    world.dispose()
  })
})

describe('chain transfer pop-up physically lifts + diverts cargo', () => {
  // The conveying deck rides the prismatic `lift` joint (examples/parts/chain-transfer): raised, its top pops
  // ~0.095 m above rest, so it physically lifts cargo to the chain height and diverts it, rather than being a flat
  // deck a box rolls straight over (as it would be if only the surface-velocity direction switched).
  function settleBottom(raised: boolean): number {
    const ct = chainTransfer('ct', 0, 0.75, 0, { raised, speed: 0 }) // speed 0: measure resting height only
    const world = new SimWorld(Jolt, scene(ct))
    world.spawnBoxAt(0, 0.75 + 0.095 + 0.15 + 0.25, 0, 0.15, 0.15, 0.15) // dropped from above the raised deck top
    for (let i = 0; i < 150; i++) world.step()
    const y = world.frame().positions[1]!
    world.dispose()
    return y - 0.15 // box centre → bottom
  }

  it('a raised transfer rests cargo ~0.095 m higher than a lowered one (the deck tracks the lift joint)', () => {
    const lowered = settleBottom(false)
    const raised = settleBottom(true)
    expect(lowered).toBeCloseTo(0.75, 1) // sits on the rest-height deck top (y = part origin)
    // a deck that never moved would settle both at the same height; the pop-up lifts the box the stroke.
    expect(raised - lowered).toBeGreaterThan(0.06)
    expect(raised - lowered).toBeLessThan(0.13)
  })

  // Running-surface split: a `conveys` link is built as a thin
  // inset conveying slab on top of a proud, plain-collision housing. Surface velocity belongs to the running
  // surface, not the whole solid, so cargo that rams the raised deck's flank must be walled, not dragged
  // sideways along the chains. Without the split the deck conveys on every face: a box fed into the raised edge
  // is dragged ~0.8 m down the divert axis and off the line.
  it('a box that rams the side of a raised transfer is walled, not dragged along the divert axis', () => {
    const r = roller('rc', 0, 0.75, 0, 6, 1) // long bed carrying +X into the raised transfer's flank
    const ct = chainTransfer('ct', 0.825, 0.75, 0, { raised: true, speed: 2 }) // deck spans x 0..1.65
    const world = new SimWorld(Jolt, scene(r, ct))
    world.spawnBoxAt(-1, 0.9, 0, 0.15, 0.15, 0.15) // rides the roller (bottom 0.75) into the raised flank
    let maxAbsZ = 0
    for (let i = 0; i < 300; i++) {
      world.step()
      maxAbsZ = Math.max(maxAbsZ, Math.abs(world.frame().positions[2]!))
    }
    const f = world.frame()
    expect(maxAbsZ).toBeLessThan(0.2) // never dragged down the divert axis (without the split it reaches ~0.78)
    expect(f.positions[0]!).toBeLessThan(0.2) // held at the deck edge instead of being pulled through
    expect(f.positions[1]!).toBeGreaterThan(0.6) // still up on the bed, not knocked off onto the floor
    world.dispose()
  })

  // Where the lowered deck rests is what makes a transfer installable in a bed at all. An idle chain deck is not
  // neutral: it is a stopped belt (surface velocity zero), and its `conveys` deck rides the lift joint, so it is a
  // kinematic body. The part declares a recess (examples/parts/chain-transfer, snap.track.targetLocalY = -0.03), so
  // the track snap seats it below the bed and cargo rides the rollers alone until the pop-up takes it. This pins
  // that the recess works; the declaration itself is guarded in editor/parts/bundledPackageData.test.ts.
  //
  // Seated flush, what holds the case back depends on the step rate, measured with the deck 0 to 5 mm proud of the
  // rollers and 2 to 10 mm below them:
  //   - below the rollers by 2 mm or more: the case rides through at every rate (3.9 m);
  //   - proud by 2 mm or more: it catches on the deck's leading edge at every rate (0.5-0.7 m);
  //   - exactly flush: at 60 Hz it catches on the leading edge (0.8 m), never reaching the deck; at 90 Hz it gets
  //     onto the deck and is braked there (1.2 m); at 120 and 240 Hz it rides over with almost no drag (3.7-3.9 m).
  // A real case on a stopped surface flush with the driven one would be dragged back while it crossed, so none of
  // the flush results is the friction the stopped deck should give. A static coplanar seam (a running roller bed
  // butted to a stopped one) behaves at every rate: the case crosses and friction stops it 0.1-0.2 m on. So the
  // flush half below holds at the default 60 Hz, by the edge catch, and is a control for the recess, not a claim
  // about flush seating.
  it('a lowered transfer resting in a running roller bed lets cargo pass; seated flush it holds it back', () => {
    const DROP = 0.03 // snap.track.targetLocalY, as a positive depth
    /** how far the box travels along the bed in 4 s with a lowered, idle transfer seated at `chainY` */
    function travel(chainY: number): number {
      const r = roller('rc', 0, 0.75, 0, 6, 1) // bed carrying +X under the transfer
      const ct = chainTransfer('ct', 0, chainY, 0, { raised: false, speed: 0 }) // chains down and NOT driving
      const world = new SimWorld(Jolt, scene(r, ct))
      world.spawnBoxAt(-1.5, 0.9, 0, 0.15, 0.15, 0.15) // upstream of the transfer (deck spans x ±0.825)
      const x0 = world.frame().positions[0]!
      for (let i = 0; i < 240; i++) world.step()
      const dx = world.frame().positions[0]! - x0
      world.dispose()
      return dx
    }
    const recessed = travel(0.75 - DROP)
    const flush = travel(0.75)
    expect(recessed).toBeGreaterThan(1.65) // clears the whole 1.65 m deck and keeps going (measured 3.89 m)
    expect(flush).toBeLessThan(recessed - 2) // flush at 60 Hz: caught on the deck's leading edge (measured 0.79 m)
  })

  it('a raised transfer diverts the box 90° off the line, along −Z (the kinematic deck still conveys)', () => {
    const ct = chainTransfer('ct', 0, 0.75, 0, { raised: true, speed: 1 })
    const world = new SimWorld(Jolt, scene(ct))
    world.spawnBoxAt(0, 0.75 + 0.095 + 0.15 + 0.1, 0.4, 0.15, 0.15, 0.15)
    const zs: number[] = []
    let lastX = 0
    for (let i = 0; i < 90; i++) { world.step(); const f = world.frame(); zs.push(f.positions[2]!); lastX = f.positions[0]! }
    expect(zs[zs.length - 1]!).toBeLessThan(zs[0]! - 0.2) // carried 90° off the line, along the chains (−Z)
    expect(Math.abs(lastX)).toBeLessThan(0.2) // not along forward (+X): the divert is perpendicular to the through flow
    world.dispose()
  })
})

describe('conveyor flank is a wall, not a drag surface (running-surface split)', () => {
  // Surface velocity belongs to a conveyor's running surface, not its whole solid. A belt run collider is a
  // full-`height` box (0.5 m tall here), so with guards off its sides are a tall exposed face. Without the split
  // a box driven into that flank is dragged 0.64 m along the belt flow and off the line. (A box merely leaning
  // on it looks fine only because the shallow-ram ghost gate hides the contact; a driven one gets past it.)
  // This must hold on the compound-facet path too, where the housing has to be its own unregistered
  // body: as a sub-shape of the registered conveyor the ghost gates would disable it and cargo would sink
  // through onto the conveying slab.
  it('a box driven sideways into a running belt flank stops instead of being carried along it', () => {
    const b = belt('b1', 0, 0.6, 0, 3, 1) // deck top 0.6; run box spans 0.10..0.60, guards off
    const feeder = roller('r1', 0, 0.3, -1.15, 1.7, 1, -Math.PI / 2) // conveys +Z into the belt's -Z flank
    const world = new SimWorld(Jolt, scene(b, feeder))
    world.spawnBoxAt(0, 0.45, -1.8, 0.15, 0.15, 0.15) // rides the feeder squarely into the belt's side band
    const x0 = world.frame().positions[0]!
    let maxAbsDx = 0
    for (let i = 0; i < 300; i++) {
      world.step()
      maxAbsDx = Math.max(maxAbsDx, Math.abs(world.frame().positions[0]! - x0))
    }
    expect(maxAbsDx).toBeLessThan(0.1) // never carried along the belt (without the split it reaches 0.64)
    expect(world.frame().positions[1]!).toBeGreaterThan(0.3) // held on the feeder, not dragged off it
    world.dispose()
  })
})

describe('roller side-guard neighbour opening', () => {
  // A box driven toward the host roller's +Z guard by roller skew (which squares cargo against the side): a
  // solid guard stops it at the host's edge, but where a neighbour conveyor butts that side the guard opens,
  // so the box crosses the junction onto the neighbour's deck. Shows the sim splits the rig guard collider at
  // the junction (the collision twin of the render mesh split): cargo transfers across a roller merge instead
  // of hitting an invisible wall. Returns the box's final +Z (cross-bed) position.
  function finalBoxZ(...parts: PartInstance[]): number {
    const world = new SimWorld(Jolt, scene(...parts))
    world.spawnBoxAt(-0.5, 0.95, 0, 0.15, 0.2, 0.15) // on the host bed; skew (below) squares it toward +Z
    for (let i = 0; i < 220; i++) world.step()
    const z = world.frame().positions[2]!
    world.dispose()
    return z
  }

  it('a solid +Z guard contains the skew-driven box; a butting neighbour opens it so the box crosses the side', () => {
    const host = roller('h', 0, 0.75, 0, 6, 1, 0, true) // guards on; strong skew (below) drives cargo hard toward +Z
    Object.assign(host.params, { skew: -55 })
    // a wide, stopped neighbour butting the host's +Z edge at x = 0, at the host's height (a junction needs the
    // two surfaces at one height: a conveyor passing below opens nothing). Its wide mouth opens the host's +Z
    // guard across the box's path; stopped, it holds the box where the host's skew pushed it.
    const opener = roller('o', 0, 0.75, 1.3, 2, 0, Math.PI / 2, false)
    Object.assign(opener.params, { width: 4 })
    const contained = finalBoxZ(host) // solid +Z guard (no neighbour): the wall (face at z = 0.31) stops the box
    const crossed = finalBoxZ(host, opener) // the neighbour opens the guard: nothing stops the box at the edge
    expect(contained).toBeLessThan(0.31) // pressed on the guard, its centre a half-box inside the face
    expect(crossed).toBeGreaterThan(0.31) // its centre past where the guard face would be
  })
})

describe('belt-to-belt boundary', () => {
  it('rides across two butted belts without popping up', SLOW, () => {
    // Two 4 m belts butted at their drum edges (centres length + 2*pulley = 4.5
    // apart, seam at x = 0, top at y = 0.75). The sim merges their decks into one
    // compound body (computeDeckClusters), so enhanced internal edge removal spans
    // the seam and cargo rides across it flat, instead of ramming the downstream
    // belt's leading edge and popping up (as it does when the two are separate
    // bodies). The box is yawed and dropped (not placed flush) so it meets the
    // seam corner-first after settling into the slop: the worst case for separate
    // bodies, which kick it up ~0.027 m at +0.86 m/s.
    const speed = 2.0
    const up = belt('up', -2.25, 0.75, 0, 4, speed)
    const down = belt('down', 2.25, 0.75, 0, 4, speed)
    up.params.width = 1.524
    down.params.width = 1.524
    const world = new SimWorld(Jolt, scene(up, down))
    const bedTop = 0.75
    const hh = 0.2
    world.spawnBoxAt(-3.5, bedTop + hh + 0.55, 0, hh, hh, hh, Math.PI / 4, 10)

    const xs: number[] = []
    const bottoms: number[] = []
    const vys: number[] = []
    let prevY = bedTop + hh
    for (let i = 0; i < DEFAULT_SIM_HZ * 5; i++) {
      world.step()
      const f = world.frame()
      const x = f.positions[0]!
      const y = f.positions[1]!
      expect(Number.isFinite(x) && Number.isFinite(y)).toBe(true)
      xs.push(x)
      bottoms.push(y - hh)
      vys.push((y - prevY) * DEFAULT_SIM_HZ)
      prevY = y
    }

    // crossed onto the downstream belt
    expect(xs[xs.length - 1]!).toBeGreaterThan(0.5)

    // Through the seam band the box must stay near deck height with no upward
    // kick. Merged, the ride sits at the resting height with vy ~0; as separate
    // bodies it pops ~0.027 m at +0.86 m/s. The 0.3 m/s / +0.02 m band
    // fails that regression while clearing the healthy ride (~0.018 m below deck).
    let checked = 0
    for (let i = 0; i < xs.length; i++) {
      if (xs[i]! < -0.7 || xs[i]! > 0.7) continue
      checked++
      expect(bottoms[i]!).toBeLessThan(bedTop + 0.02)
      expect(bottoms[i]!).toBeGreaterThan(bedTop - 0.06)
      expect(vys[i]!).toBeLessThan(0.3)
    }
    expect(checked).toBeGreaterThan(0)

    world.dispose()
  })

  it('merges and conveys flat across a rotated (90deg) butted pair', SLOW, () => {
    // rotationY = 90deg: flow is world -Z (forwardXZ). The two belts butt along Z
    // (centres 4.5 apart), seam at world z = -2.25. This exercises worldSub lifting
    // each member's facets into world space for the merged compound - if the yaw
    // transform or the world-space surface velocity were wrong, the box would
    // convey the wrong way or pop. It must flow -Z and ride flat across the seam.
    const speed = 2.0
    const ry = Math.PI / 2
    const a = belt('a', 0, 0.75, 0, 4, speed, ry)
    const b = belt('b', 0, 0.75, -4.5, 4, speed, ry)
    const world = new SimWorld(Jolt, scene(a, b))
    const bedTop = 0.75
    const hh = 0.2
    world.spawnBoxAt(0, bedTop + hh + 0.35, 1.5, hh, hh, hh, Math.PI / 4, 10)

    const zs: number[] = []
    const bottoms: number[] = []
    const vys: number[] = []
    let prevY = bedTop + hh
    for (let i = 0; i < DEFAULT_SIM_HZ * 4; i++) {
      world.step()
      const f = world.frame()
      zs.push(f.positions[2]!)
      bottoms.push(f.positions[1]! - hh)
      vys.push((f.positions[1]! - prevY) * DEFAULT_SIM_HZ)
      prevY = f.positions[1]!
    }

    // conveyed in -Z and crossed the seam at z = -2.25
    expect(zs[zs.length - 1]!).toBeLessThan(-2.85)
    const seam = -2.25
    let checked = 0
    for (let i = 0; i < zs.length; i++) {
      if (zs[i]! > seam + 0.7 || zs[i]! < seam - 0.7) continue
      checked++
      expect(bottoms[i]!).toBeLessThan(bedTop + 0.02)
      expect(bottoms[i]!).toBeGreaterThan(bedTop - 0.06)
      expect(vys[i]!).toBeLessThan(0.3)
    }
    expect(checked).toBeGreaterThan(0)

    world.dispose()
  })
})

describe('sideways transfer across the bed frame', () => {
  // The demo diverter kicks a box sideways off the infeed roller bed onto a perpendicular takeaway.
  // Two hazards guard that path: (1) a collision body on the roller's frame flange, its top exactly at the
  // deck plane, is a phantom curb the sliding box rams and pops on (so it is noCollision in the rig);
  // (2) a conveying rig's frame wall is a separate body, so the conveyor ghost gates
  // must cover it - cargo rests a hair sunk into the deck (up to the slop), so its leading bottom edge
  // can ram a near-flush rail top edge (+1.2 m/s pop, ~4deg pitch measured in the demo). These pin both.

  it('a skew-driven box slides off the roller bed onto a perpendicular takeaway without popping', SLOW, () => {
    const host = roller('h', 0, 0.75, 0, 6, 2) // skew (below) drives cargo hard toward +Z
    Object.assign(host.params, { skew: -55 })
    // takeaway butting the host's +Z edge (host deck edge z = 0.3), flow axis perpendicular and carrying
    // away from the junction (+Z) - the demo's divert junction. Wide in x so the box, which keeps its +x
    // momentum while crossing, lands on it.
    const take = roller('t', 0, 0.75, 1.8, 3, 1, -Math.PI / 2)
    take.params.width = 3
    const world = new SimWorld(Jolt, scene(host, take))
    const bedTop = 0.75
    const hh = 0.15
    world.spawnBoxAt(-0.9, bedTop + hh + 0.02, 0, hh, hh, hh, 0, 10)

    const zs: number[] = []
    const bottoms: number[] = []
    const vys: number[] = []
    let prevY = bedTop + hh
    for (let i = 0; i < DEFAULT_SIM_HZ * 3; i++) {
      world.step()
      const f = world.frame()
      zs.push(f.positions[2]!)
      bottoms.push(f.positions[1]! - hh)
      vys.push((f.positions[1]! - prevY) * DEFAULT_SIM_HZ)
      prevY = f.positions[1]!
    }

    expect(zs[zs.length - 1]!).toBeGreaterThan(0.6) // crossed the frame band onto the takeaway
    // through the bed-edge band (deck edge 0.3, wall to 0.31, flange to 0.33) the box must stay at deck
    // height with no upward kick; a flange curb would launch it here.
    let checked = 0
    for (let i = 0; i < zs.length; i++) {
      if (zs[i]! < 0.05 || zs[i]! > 0.6) continue
      checked++
      expect(bottoms[i]!).toBeLessThan(bedTop + 0.02)
      expect(bottoms[i]!).toBeGreaterThan(bedTop - 0.06)
      expect(vys[i]!).toBeLessThan(0.3)
    }
    expect(checked).toBeGreaterThan(0)
    world.dispose()
  })

  it("a conveying rig's flush frame rail is ghost-gated: cargo slides across it without popping", SLOW, () => {
    // A minimal conveying rig with the worst-case bed edge: a frame rail whose top sits exactly at the
    // deck plane. With frame bodies outside the conveyor set (never ghost-filtered), the sliding box would
    // ram the rail's inner edge and pop; gated, it slides straight over the flush top.
    const behavior = `definePart({
  params: { speed: { type: 'number', default: 2 } },
  step(ctx) { ctx.setSurfaceVelocity({ x: 0, y: 0, z: ctx.params.speed }) },
})
`
    const pkg = buildPackage(
      {
        id: 'test.frame-lip',
        name: 'Frame Lip',
        geometry: {
          kind: 'rig',
          links: [
            { name: 'deck', shape: { kind: 'box', size: [2, 0.04, 1] }, offset: [0, -0.02, 0], conveys: true, hidden: true },
            { name: 'rail', shape: { kind: 'box', size: [2, 0.2, 0.02] }, offset: [0, -0.1, 0.51], finish: 'frame', bed: true },
          ],
          joints: [],
          bounds: { length: 2, width: 1.1, top: 0.3 },
        },
      },
      behavior,
    )
    registerPackage(pkg)
    const world = new SimWorld(Jolt, scene(createSdkPart(pkg, 'fl', [0, 0.75, 0], 0)))
    const bedTop = 0.75
    const hh = 0.15
    world.spawnBoxAt(0, bedTop + hh + 0.02, 0, hh, hh, hh, 0, 10)

    const zs: number[] = []
    const bottoms: number[] = []
    const vys: number[] = []
    let prevY = bedTop + hh
    for (let i = 0; i < DEFAULT_SIM_HZ * 2; i++) {
      world.step()
      const f = world.frame()
      zs.push(f.positions[2]!)
      bottoms.push(f.positions[1]! - hh)
      vys.push((f.positions[1]! - prevY) * DEFAULT_SIM_HZ)
      prevY = f.positions[1]!
    }

    expect(zs[zs.length - 1]!).toBeGreaterThan(0.5) // carried past the rail, not wedge-stopped on it
    // approaching + crossing the rail (inner face z = 0.50, box leading edge z+hh) the ride stays flat
    let checked = 0
    for (let i = 0; i < zs.length; i++) {
      if (zs[i]! < 0.15 || zs[i]! > 0.45) continue
      checked++
      expect(bottoms[i]!).toBeLessThan(bedTop + 0.02)
      expect(bottoms[i]!).toBeGreaterThan(bedTop - 0.06)
      expect(vys[i]!).toBeLessThan(0.3)
    }
    expect(checked).toBeGreaterThan(0)
    world.dispose()
  })
})

describe('cargo rests flush and stacks stably', () => {
  // tightened penetration slop: a dropped box should sit ~flush, not sunk ~2 cm
  it('a dropped box rests near-flush on the floor', SLOW, () => {
    const world = new SimWorld(Jolt, scene()) // ground only, top at y=0
    const hh = 0.2
    world.spawnBoxAt(0, hh + 0.5, 0, hh, hh, hh, 0, 10) // hard drop onto the floor
    let bottom = 0
    for (let i = 0; i < DEFAULT_SIM_HZ * 3; i++) {
      world.step()
      bottom = world.frame().positions[1]! - hh
    }
    // with the default 0.02 slop this settles near -0.018; tightened it rests within ~5 mm
    expect(bottom).toBeGreaterThan(-0.01)
    expect(bottom).toBeLessThan(0.01)
    world.dispose()
  })

  it('a stack of four boxes settles without jitter', SLOW, () => {
    const world = new SimWorld(Jolt, scene())
    const hh = 0.2
    for (let k = 0; k < 4; k++) world.spawnBoxAt(0, hh + k * (2 * hh) + 0.01, 0, hh, hh, hh, 0, 5)
    for (let i = 0; i < DEFAULT_SIM_HZ * 4; i++) world.step() // settle

    // over the next 0.5 s the stack must be at rest: a too-small slop jitters here
    const prev = new Map<number, number>()
    let maxSpeed = 0
    for (let i = 0; i < DEFAULT_SIM_HZ / 2; i++) {
      world.step()
      const f = world.frame()
      for (let b = 0; b < f.count; b++) {
        const id = f.ids[b]!
        const y = f.positions[b * 3 + 1]!
        if (prev.has(id)) maxSpeed = Math.max(maxSpeed, Math.abs(y - prev.get(id)!) * DEFAULT_SIM_HZ)
        prev.set(id, y)
      }
    }
    const f = world.frame()
    expect(f.count).toBe(4) // none ejected/culled
    expect(maxSpeed).toBeLessThan(0.05) // settled, no resting jitter
    // not collapsed: the four centres are spread ~one box-height apart up to ~1.4 m
    const ys = Array.from({ length: 4 }, (_, b) => f.positions[b * 3 + 1]!).sort((a, b) => a - b)
    expect(ys[0]!).toBeLessThan(hh + 0.05)
    expect(ys[3]!).toBeGreaterThan(hh + 3 * (2 * hh) - 0.08)
    world.dispose()
  })
})

describe('building', () => {
  it('perimeter wall stops a conveyed box inside the footprint, even hidden', SLOW, () => {
    const bld: BuildingPart = {
      type: 'building',
      id: 'bld1',
      position: [0, 0, 0],
      rotationY: 0,
      // hidden walls still collide; 2x2 sections = 20x20 m
      params: { lengthSections: 2, widthSections: 2, heightSections: 1, rules: [], floorVisible: true, wallsVisible: false, roofVisible: true, brightness: 1, backgroundColor: '#9fb1c4' },
    }
    // bed spans x 4..10, poking into the +X wall (inner face at 9.8)
    const world = new SimWorld(Jolt, scene(bld, roller('c1', 7, 0.75, 0, 6, 0.5)))
    world.spawnBoxAt(4.5, 0.97, 0, 0.15, 0.2, 0.15)
    const xs: number[] = []
    const ys: number[] = []
    for (let i = 0; i < 60 * 16; i++) recordStep(world, xs, ys)
    const n = xs.length
    const vx = (xs[n - 1]! - xs[n - 61]!) * (DEFAULT_SIM_HZ / 60)
    expect(Math.abs(vx)).toBeLessThan(0.03)
    // stalled against the wall: front face short of the inner wall face
    expect(xs[n - 1]!).toBeGreaterThan(9.2)
    expect(xs[n - 1]! + 0.15).toBeLessThan(10 - 0.2 + 0.02)
    // still riding the bed, not climbing the wall
    const bottom = ys[n - 1]! - 0.2
    expect(bottom).toBeGreaterThan(0.75 - 0.06)
    expect(bottom).toBeLessThan(0.75 + 0.06)
    world.dispose()
  })

  it('an interior column stops a conveyed box that runs into it', SLOW, () => {
    // 4x4 sections every 2 = one grid line each way through the centre: a single column at the origin
    const bld: BuildingPart = {
      type: 'building',
      id: 'bld1',
      position: [0, 0, 0],
      rotationY: 0,
      params: { lengthSections: 4, widthSections: 4, heightSections: 1, columnSpacing: 2, rules: [], floorVisible: true, wallsVisible: true, roofVisible: true, brightness: 1, backgroundColor: '#9fb1c4' },
    }
    // bed spans x -4..2, straight through the column (faces at x = ±0.2)
    const world = new SimWorld(Jolt, scene(bld, roller('c1', -1, 0.75, 0, 6, 0.5)))
    world.spawnBoxAt(-3.5, 0.97, 0, 0.15, 0.2, 0.15)
    const xs: number[] = []
    const ys: number[] = []
    for (let i = 0; i < 60 * 8; i++) recordStep(world, xs, ys)
    const n = xs.length
    const vx = (xs[n - 1]! - xs[n - 61]!) * (DEFAULT_SIM_HZ / 60)
    expect(Math.abs(vx)).toBeLessThan(0.03)
    expect(xs[n - 1]!).toBeGreaterThan(-1)
    expect(xs[n - 1]! + 0.15).toBeLessThan(-0.2 + 0.02)
    world.dispose()
  })
})

describe('three-conveyor line', () => {
  const lineScene = scene(
    roller('c1', 0, 0.75, 0, 3, 0.5),
    roller('c2', 2.5, 0.75, 0, 2, 0.5),
    roller('c3', 5, 0.75, 0, 3, 0.5),
  )
  let world: SimWorld

  it('conveys across junctions without snagging or sinking', SLOW, () => {
    world = new SimWorld(Jolt, lineScene)
    world.spawnBoxAt(-1.3, 0.97, 0, 0.15, 0.2, 0.15)
    const xs: number[] = []
    const ys: number[] = []
    let crossed = false
    for (let i = 0; i < 60 * 30; i++) {
      recordStep(world, xs, ys)
      if (xs[xs.length - 1]! > 6.5) {
        crossed = true
        break
      }
    }
    expect(crossed).toBe(true)

    const onBed = (i: number) => xs[i]! >= -1.3 && xs[i]! <= 6.3
    for (let i = 0; i < xs.length; i++) {
      if (onBed(i)) {
        const bottom = ys[i]! - 0.2
        expect(bottom).toBeGreaterThan(0.75 - 0.06)
        expect(bottom).toBeLessThan(0.75 + 0.06)
      }
    }
    for (let i = 2 * DEFAULT_SIM_HZ; i + DEFAULT_SIM_HZ < xs.length; i++) {
      if (onBed(i) && onBed(i + DEFAULT_SIM_HZ)) {
        expect(xs[i + DEFAULT_SIM_HZ]! - xs[i]!).toBeGreaterThan(0.15)
      }
    }
  })

  it('falls off the far end', SLOW, () => {
    let fell = false
    for (let i = 0; i < 60 * 5; i++) {
      world.step()
      if (world.frame().positions[1]! < 0.5) {
        fell = true
        break
      }
    }
    expect(fell).toBe(true)
    for (let i = 0; i < 60 * 4; i++) world.step()
    const y = world.frame().positions[1]!
    expect(y).toBeLessThan(0.35)
    expect(y).toBeGreaterThan(0.05)
    world.dispose()
  })
})

describe('cargo parts', () => {
  it('a box part on a belt conveys +x at belt speed with the box kind', SLOW, () => {
    const world = new SimWorld(Jolt, scene(belt('b1', 0, 0.75, 0, 4, 0.5), boxPart('bx1', -1.5, 0.95, 0)))
    const xs: number[] = []
    const ys: number[] = []
    for (let i = 0; i < 180; i++) recordStep(world, xs, ys)
    const vx = (xs[179]! - xs[149]!) * (DEFAULT_SIM_HZ / 30)
    expect(vx).toBeGreaterThan(0.4)
    expect(vx).toBeLessThan(0.6)
    expect(xs[179]!).toBeGreaterThan(xs[0]!)
    const f = world.frame()
    expect(f.kinds[0]).toBe(CARGO_KIND_BOX)
    expect(f.halfExtents[0]!).toBeCloseTo(0.3, 6)
    expect(f.halfExtents[1]!).toBeCloseTo(0.2, 6)
    expect(f.halfExtents[2]!).toBeCloseTo(0.2, 6)
    world.dispose()
  })

  it('a pallet part rests stable on the floor', SLOW, () => {
    const world = new SimWorld(Jolt, scene(palletPart('pl1', 2, PALLET_SIZE[1] / 2, 1, 0.5)))
    for (let i = 0; i < DEFAULT_SIM_HZ * 2; i++) world.step()
    const f = world.frame()
    expect(f.count).toBe(1)
    expect(f.kinds[0]).toBe(CARGO_KIND_PALLET)
    expect(f.positions[1]!).toBeCloseTo(PALLET_SIZE[1] / 2, 2)
    expect(Math.abs(f.positions[0]! - 2)).toBeLessThan(0.01)
    expect(Math.abs(f.positions[2]! - 1)).toBeLessThan(0.01)
    expect(f.halfExtents[0]!).toBeCloseTo(PALLET_SIZE[0] / 2, 6)
    expect(f.halfExtents[1]!).toBeCloseTo(PALLET_SIZE[1] / 2, 6)
    expect(f.halfExtents[2]!).toBeCloseTo(PALLET_SIZE[2] / 2, 6)
    world.dispose()
  })

  it('a fresh world from the same scene restores authored cargo poses', SLOW, () => {
    const s = scene(
      roller('c1', 0, 0.75, 0, 3, 0.5),
      boxPart('bx1', -1, 0.95, 0.1, 0.3),
      palletPart('pl1', 3, PALLET_SIZE[1] / 2, -2),
    )
    const w1 = new SimWorld(Jolt, s)
    for (let i = 0; i < DEFAULT_SIM_HZ; i++) w1.step()
    expect(w1.frame().positions[0]!).toBeGreaterThan(-0.9)
    w1.dispose()

    const w2 = new SimWorld(Jolt, s)
    const f = w2.frame()
    expect(f.count).toBe(2)
    expect(Array.from(f.kinds)).toEqual([CARGO_KIND_BOX, CARGO_KIND_PALLET])
    expect(f.positions[0]!).toBeCloseTo(-1, 5)
    expect(f.positions[1]!).toBeCloseTo(0.95, 5)
    expect(f.positions[2]!).toBeCloseTo(0.1, 5)
    expect(f.positions[3]!).toBeCloseTo(3, 5)
    expect(f.positions[4]!).toBeCloseTo(PALLET_SIZE[1] / 2, 5)
    expect(f.positions[5]!).toBeCloseTo(-2, 5)
    expect(f.quats[1]!).toBeCloseTo(Math.sin(0.15), 5)
    expect(f.quats[3]!).toBeCloseTo(Math.cos(0.15), 5)
    w2.dispose()
  })
})

describe('freeze body (gizmo grab)', () => {
  it('a frozen box holds its pose against gravity and the conveyor, then resumes', SLOW, () => {
    const world = new SimWorld(Jolt, scene(belt('b1', 0, 0.75, 0, 4, 0.5), boxPart('bx1', 0, 0.95, 0)))
    for (let i = 0; i < 30; i++) world.step()
    // freeze: the grabbed box stops conveying and stops falling
    world.freezeBody('bx1', true)
    const held = world.frame()
    const [hx, hy] = [held.positions[0]!, held.positions[1]!]
    for (let i = 0; i < 120; i++) world.step()
    const f = world.frame()
    expect(Math.abs(f.positions[0]! - hx)).toBeLessThan(1e-3)
    expect(Math.abs(f.positions[1]! - hy)).toBeLessThan(1e-3)
    // a gizmo drag teleports the held body and it stays put across steps
    world.moveBody('bx1', [1, 1.5, 0], null)
    for (let i = 0; i < 60; i++) world.step()
    const moved = world.frame()
    expect(moved.positions[0]!).toBeCloseTo(1, 3)
    expect(moved.positions[1]!).toBeCloseTo(1.5, 3)
    // release: dynamic again, so it falls toward the belt
    world.freezeBody('bx1', false)
    for (let i = 0; i < 120; i++) world.step()
    expect(world.frame().positions[1]!).toBeLessThan(1.5)
    world.dispose()
  })

  it('a step reads a body moved since the frame, not the frame snapshot it would reuse', () => {
    const world = new SimWorld(Jolt, scene(belt('b1', 0, 0.75, 0, 4, 0.5), boxPart('bx1', 0, 0.95, 0)))
    world.step()
    expect(world.frame().count).toBe(1) // the frame's snapshot is kept for the next step
    // dragged below the cull height between steps: the next step's cull must see it there
    world.moveBody('bx1', [0, -10, 0], null)
    world.step()
    expect(world.frame().count).toBe(0)
    world.dispose()
  })

  it('a body moved between steps after something read the snapshot is still seen by the next step', () => {
    const world = new SimWorld(Jolt, scene(belt('b1', 0, 0.75, 0, 4, 0.5), boxPart('bx1', 0, 0.95, 0)))
    world.step()
    world.frame()
    // a query between steps reads the cached snapshot first; that must not stop the move below from invalidating it
    ;(world as unknown as { cargo: { stepSnapshot(): unknown } }).cargo.stepSnapshot()
    world.moveBody('bx1', [0, -10, 0], null)
    world.step()
    expect(world.frame().count).toBe(0)
    world.dispose()
  })

  it('a step reads a grip pose set since the frame', () => {
    const world = new SimWorld(Jolt, scene(belt('b1', 0, 0.75, 0, 4, 0.5), boxPart('bx1', 0, 0.95, 0)))
    world.step()
    const id = world.frame().ids[0]!
    world.grabBody(id)
    world.setGrabbedPose(id, [0, -10, 0], [0, 0, 0, 1])
    world.step()
    expect(world.frame().count).toBe(0)
    world.dispose()
  })
})

describe('tilted cargo (full orientation)', () => {
  // quaternion equality up to sign (q and -q are the same rotation)
  const expectQuat = (f: { quats: Float32Array }, q: readonly number[], digits: number): void => {
    const s = f.quats[3]! * q[3]! < 0 ? -1 : 1
    for (let i = 0; i < 4; i++) expect(f.quats[i]!).toBeCloseTo(s * q[i]!, digits)
  }

  it('an authored box with rotationX/Z spawns with its full YXZ orientation, not just yaw', () => {
    const tilted = boxPart('bx1', 0, 2, 0, 0.5)
    tilted.rotationX = 0.3
    tilted.rotationZ = -0.2
    const world = new SimWorld(Jolt, scene(tilted))
    expectQuat(world.frame(), quatFromYXZ(0.3, 0.5, -0.2), 5)
    world.dispose()
  })

  it('moveBody with a quaternion tilts a frozen live box (tilt-ring drag while running)', SLOW, () => {
    const world = new SimWorld(Jolt, scene(belt('b1', 0, 0.75, 0, 4, 0.5), boxPart('bx1', 0, 0.95, 0)))
    for (let i = 0; i < 30; i++) world.step()
    world.freezeBody('bx1', true)
    const q = quatFromYXZ(0.4, 0.6, -0.25)
    world.moveBody('bx1', [1, 1.5, 0], q)
    for (let i = 0; i < 60; i++) world.step()
    const f = world.frame()
    expect(f.positions[0]!).toBeCloseTo(1, 3)
    expect(f.positions[1]!).toBeCloseTo(1.5, 3)
    expectQuat(f, q, 3) // kinematic: the tilt holds against gravity and the belt
    world.dispose()
  })
})

describe('pilot carry (hold body)', () => {
  it('a held box follows its hold point, floats without gravity, and cannot be driven through the conveyor', SLOW, () => {
    const world = new SimWorld(Jolt, scene(belt('b1', 0, 0.75, 0, 4, 0), boxPart('bx1', 0, 0.95, 0)))
    for (let i = 0; i < 30; i++) world.step() // settle on the belt
    world.holdBody('bx1', true)
    // follows the hold point up into open air and floats there (gravity off)
    world.setHoldTarget('bx1', [0, 1.8, 0], 0)
    for (let i = 0; i < 120; i++) world.step()
    const f = world.frame()
    expect(f.positions[1]!).toBeCloseTo(1.8, 1)
    expect(Math.abs(f.positions[0]!)).toBeLessThan(0.05)
    expect(Math.abs(f.positions[2]!)).toBeLessThan(0.05)
    for (let i = 0; i < 120; i++) world.step() // doesn't sag with no gravity
    expect(world.frame().positions[1]!).toBeCloseTo(1.8, 1)
    // the fix: a hold point below the belt deck must not pull the box under it -
    // collisions resolve, so it rests on the deck instead of clipping through
    world.setHoldTarget('bx1', [0, -1, 0], 0)
    for (let i = 0; i < 180; i++) world.step()
    expect(world.frame().positions[1]!).toBeGreaterThan(0.9)
    // release: gravity returns and it settles back onto the belt
    world.holdBody('bx1', false)
    for (let i = 0; i < 120; i++) world.step()
    const settled = world.frame().positions[1]!
    expect(settled).toBeGreaterThan(0.85)
    expect(settled).toBeLessThan(1.05)
    world.dispose()
  })

  it('a carried box is in a person\'s hands, not on the line: a sink\'s zone neither counts nor removes it', SLOW, () => {
    const sink = createSdkPart(DESPAWNER_PKG, 'sink', [0, 0, 0], 0) // a 2 x 1 x 2 m mouth at the origin
    const world = new SimWorld(Jolt, scene(sink, boxPart('bx1', 3, 0.2, 0)))
    for (let i = 0; i < 30; i++) world.step()
    world.holdBody('bx1', true)
    world.setHoldTarget('bx1', [0, 0.5, 0], 0) // carried into the middle of the mouth
    for (let i = 0; i < 180; i++) world.step()
    expect(world.frame().positions.length).toBeGreaterThan(0) // still in hand
    expect(Math.abs(world.frame().positions[0]!)).toBeLessThan(0.1)
    world.holdBody('bx1', false) // put down there: now it is cargo in the sink
    for (let i = 0; i < 10; i++) world.step()
    expect(world.frame().positions.length).toBe(0)
    world.dispose()
  })
})

describe('pilot push (body capsule)', () => {
  it('the pilot body shoves a resting box along as it walks into it, then stops when it leaves', SLOW, () => {
    const world = new SimWorld(Jolt, scene(boxPart('bx1', 0, 0.2, 0)))
    for (let i = 0; i < 30; i++) world.step() // settle the box on the floor
    const x0 = world.frame().positions[0]!
    // walk the pilot in from -X toward the box, advancing the feet a small step each
    // frame the way the render thread sends per-frame deltas (a teleport would fling it)
    let px = -1.5
    for (let i = 0; i < 150; i++) {
      px += 0.025 // ~1.5 m/s
      world.setPilotBody([px, 0, 0])
      world.step()
    }
    const pushed = world.frame()
    expect(pushed.positions[0]!).toBeGreaterThan(x0 + 0.3) // shoved forward
    expect(pushed.positions[1]!).toBeGreaterThan(0.1) // rode along the floor, not launched
    // leaving pilot mode tears the capsule down; the box then just coasts to rest
    world.setPilotBody(null)
    for (let i = 0; i < 30; i++) world.step()
    const rested = world.frame().positions[0]!
    for (let i = 0; i < 60; i++) world.step()
    expect(Math.abs(world.frame().positions[0]! - rested)).toBeLessThan(0.2)
    world.dispose()
  })
})

describe('live editing (updateScene)', () => {
  it('reverses a belt live, keeping the spawned box', SLOW, () => {
    const world = new SimWorld(Jolt, scene(belt('b1', 0, 0.75, 0, 4, 0.5)))
    world.spawnBoxAt(-1.5, 0.97, 0, 0.15, 0.2, 0.15)
    for (let i = 0; i < 60; i++) world.step()
    const xForward = world.frame().positions[0]!
    expect(xForward).toBeGreaterThan(-1.5)

    // flip the belt direction without restarting: the box must survive and reverse
    world.updateScene(scene(belt('b1', 0, 0.75, 0, 4, -0.5)))
    expect(world.frame().count).toBe(1)
    for (let i = 0; i < 150; i++) world.step()
    expect(world.frame().positions[0]!).toBeLessThan(xForward)
    world.dispose()
  })

  it('removing the conveyor drops the cargo it supported', SLOW, () => {
    const world = new SimWorld(Jolt, scene(belt('b1', 0, 0.75, 0, 4, 0)))
    world.spawnBoxAt(0, 0.97, 0, 0.15, 0.2, 0.15)
    for (let i = 0; i < 30; i++) world.step()
    expect(world.frame().positions[1]!).toBeGreaterThan(0.85)

    world.updateScene(scene())
    expect(world.frame().count).toBe(1) // the box outlives the deleted part
    for (let i = 0; i < 90; i++) world.step()
    expect(world.frame().positions[1]!).toBeLessThan(0.5) // now resting on the ground
    world.dispose()
  })

  it('adding a conveyor catches a falling box', SLOW, () => {
    const world = new SimWorld(Jolt, scene())
    world.spawnBoxAt(0, 2, 0, 0.15, 0.2, 0.15)
    world.updateScene(scene(belt('b1', 0, 0.75, 0, 4, 0.5)))
    for (let i = 0; i < 120; i++) world.step()
    const f = world.frame()
    expect(f.positions[1]!).toBeGreaterThan(0.7) // riding the new belt, not fallen to the floor
    expect(f.positions[0]!).toBeGreaterThan(0.05) // conveyed +x
    world.dispose()
  })

  it('adopts a transient (spawned) box as a part without duplicating or teleporting its body', SLOW, () => {
    const world = new SimWorld(Jolt, scene(belt('b1', 0, 0.75, 0, 6, 0.5)))
    world.spawnBoxAt(-2, 1.0, 0, 0.3, 0.2, 0.2) // a transient box (no owning part), as a spawner emits
    let f = world.frame()
    expect(f.count).toBeGreaterThan(0)
    const bodyId = f.ids[0]!
    expect(f.partIds[0]).toBe(null) // transient: no owning part
    const n = f.count
    const pos: [number, number, number] = [f.positions[0]!, f.positions[1]!, f.positions[2]!]

    // promote: bind the existing body to a new part, then push the scene that now contains it
    world.adopt(bodyId, 'bx_1')
    const promoted = boxPart('bx_1', pos[0], pos[1], pos[2])
    world.updateScene(scene(belt('b1', 0, 0.75, 0, 6, 0.5), promoted))
    f = world.frame()
    expect(f.count).toBe(n) // no second body built for the promoted part
    const idx = Array.from(f.ids).indexOf(bodyId)
    expect(idx).toBeGreaterThanOrEqual(0) // adopted body still alive
    expect(f.partIds[idx]).toBe('bx_1')

    // deleting the part removes its live body
    world.updateScene(scene(belt('b1', 0, 0.75, 0, 6, 0.5)))
    expect(Array.from(world.frame().ids)).not.toContain(bodyId)
    world.dispose()
  })

  it('a no-op update leaves a conveying box undisturbed', SLOW, () => {
    const s = scene(belt('b1', 0, 0.75, 0, 4, 0.5))
    const world = new SimWorld(Jolt, s)
    world.spawnBoxAt(-1.5, 0.97, 0, 0.15, 0.2, 0.15)
    for (let i = 0; i < 90; i++) world.step()
    const before = world.frame().positions[0]!
    world.updateScene(s) // identical scene: signatures match, nothing rebuilds
    expect(world.frame().count).toBe(1)
    for (let i = 0; i < 30; i++) world.step()
    expect(world.frame().positions[0]!).toBeGreaterThan(before) // still conveying +x
    world.dispose()
  })

  it('a part whose package the sim was not given reports it, and builds once the package arrives', SLOW, () => {
    // The worker knows only the packages a scene hands it. A belt pasted into a scene that never embedded its
    // package still draws, but here it has no deck: a box spawned over it falls to the floor.
    unregisterPackage(BELT_PKG.id)
    clearPartDiagnostics()
    try {
      const world = new SimWorld(Jolt, scene(belt('b1', 0, 0.75, 0, 4, 0)))
      expect(partDiagnosticsFor('b1').map((d) => d.source)).toEqual(['build'])
      world.spawnBoxAt(0, 1.2, 0, 0.15, 0.2, 0.15)
      for (let i = 0; i < 90; i++) world.step()
      expect(world.frame().positions[1]!).toBeLessThan(0.5)

      // the next push carries the package: the part rebuilds, its report clears, and the deck catches cargo
      world.updateScene({ ...scene(belt('b1', 0, 0.75, 0, 4, 0)), packages: [BELT_PKG] })
      expect(partDiagnosticsFor('b1')).toEqual([])
      world.spawnBoxAt(0, 1.2, 0, 0.15, 0.2, 0.15)
      for (let i = 0; i < 90; i++) world.step()
      expect(world.frame().positions[4]!).toBeGreaterThan(0.85)
      world.dispose()
    } finally {
      registerPackage(BELT_PKG)
    }
  })

  it('a rebuilt or deleted part leaves no behavior running', SLOW, () => {
    const count = (w: SimWorld): number => (w as unknown as { bus: { behaviors: unknown[] } }).bus.behaviors.length
    const tagged = (tag: string): SdkPart => {
      const p = belt('b1', 0, 0.75, 0, 4, 0.5)
      p.params.runningTag = tag
      return p
    }
    const world = new SimWorld(Jolt, scene(tagged('B1_RUN')))
    world.step()
    expect(world.behaviorTagWrites()).toMatchObject({ B1_RUN: true })
    // renaming the tag rebuilds the part: only the new tag is written, by one behavior
    world.updateScene(scene(tagged('B1_RUN_2')))
    world.step()
    expect(count(world)).toBe(1)
    expect(world.behaviorTagWrites()).toHaveProperty('B1_RUN_2', true)
    expect(world.behaviorTagWrites()).not.toHaveProperty('B1_RUN')
    // deleting it stops it
    world.updateScene(scene())
    world.step()
    expect(count(world)).toBe(0)
    expect(world.behaviorTagWrites()).not.toHaveProperty('B1_RUN_2')
    world.dispose()
  })

  it('editing one belt of a merged deck keeps every member conveying', SLOW, () => {
    // the cluster owner attaches every member's behavior, and any member's edit rebuilds them all
    const count = (w: SimWorld): number => (w as unknown as { bus: { behaviors: unknown[] } }).bus.behaviors.length
    const pair = (upSpeed: number, downSpeed: number): SceneJSON => scene(belt('up', -2.25, 0.75, 0, 4, upSpeed), belt('down', 2.25, 0.75, 0, 4, downSpeed))
    const world = new SimWorld(Jolt, pair(0.5, 0.5))
    expect(count(world)).toBe(2)
    for (const [up, down] of [[0.6, 0.5], [0.6, 0.7]] as const) {
      world.updateScene(pair(up, down))
      expect(count(world)).toBe(2)
    }
    // a box on each belt still moves at its belt's speed
    world.spawnBoxAt(-3.5, 0.97, 0, 0.15, 0.2, 0.15)
    world.spawnBoxAt(1, 0.97, 0, 0.15, 0.2, 0.15)
    for (let i = 0; i < 60; i++) world.step()
    const x0 = [world.frame().positions[0]!, world.frame().positions[3]!]
    for (let i = 0; i < 30; i++) world.step()
    const v = [(world.frame().positions[0]! - x0[0]!) * 2, (world.frame().positions[3]! - x0[1]!) * 2]
    expect(v[0]).toBeGreaterThan(0.45)
    expect(v[1]).toBeGreaterThan(0.6)
    world.dispose()
  })

  it('a part added to a full physics world is built without bodies and reported, never half built', SLOW, () => {
    const world = new SimWorld(Jolt, scene())
    // fill Jolt's body table with cargo (nothing caps cargo: a line with no outlet piles up like this)
    let n = 0
    while (world.spawnBoxAt((n % 100) * 0.5, 1 + Math.floor(n / 100) * 0.5, 0, 0.1, 0.1, 0.1) >= 0) n++
    expect(n).toBeGreaterThan(1000)
    clearPartDiagnostics()
    world.updateScene(scene(belt('b1', 0, 0.75, 0, 4, 0.5)))
    expect(partDiagnosticsFor('b1').map((d) => d.source)).toEqual(['build'])
    expect((world as unknown as { partGroups: Map<string, { bodies: unknown[] }> }).partGroups.get('b1')?.bodies).toEqual([])
    expect(() => world.step()).not.toThrow()
    // an unrelated edit leaves the bodiless part alone (same signature), so it does not retry on every update
    world.updateScene(scene(belt('b1', 0, 0.75, 0, 4, 0.5)))
    expect(partDiagnosticsFor('b1')[0]?.count).toBe(1)
    world.dispose()
    clearPartDiagnostics()
  })
})

describe('cargo count', () => {
  // Nothing caps cargo, so a line with no outlet piles up as it would on a real floor. A cap that deletes the
  // oldest spawned body would take the bottom of a palletizing line's finished stacks, collapsing them mid-run.
  it('keeps every box past 200, with authored cargo in the scene', SLOW, () => {
    const authored = Array.from({ length: 40 }, (_, i) => boxPart(`bx_${i}`, -15 + i * 0.8, 0.25, -6))
    const world = new SimWorld(Jolt, scene(...authored))
    const spawned: number[] = []
    for (let i = 0; i < 250; i++) spawned.push(world.spawnBoxAt(-4 + (i % 16) * 0.5, 0.16, Math.floor(i / 16) * 0.5, 0.15, 0.15, 0.15))
    expect(spawned).not.toContain(-1)
    for (let i = 0; i < 30; i++) world.step()
    const ids = Array.from(world.frame().ids)
    expect(ids).toHaveLength(290)
    expect(ids).toContain(spawned[0]) // the first box spawned: the one the cap deleted first
    world.dispose()
  })

  // What does run out is Jolt's body table (10240 by default). Past it CreateBody hands back a NULL body without
  // throwing, so an unguarded spawn would list a box that has no physics behind it.
  it('skips a spawn once the physics body table is full, rather than listing a box with no body', SLOW, () => {
    const world = new SimWorld(Jolt, scene())
    let made = 0
    let refused = false
    for (let i = 0; i < 11000 && !refused; i++) {
      const id = world.spawnBoxAt(-25 + (i % 100) * 0.5, 0.16, -25 + Math.floor(i / 100) * 0.5, 0.15, 0.15, 0.15)
      if (id < 0) refused = true
      else made++
    }
    expect(refused).toBe(true)
    expect(made).toBeGreaterThan(10000) // the static ground takes the rest of the 10240
    const f = world.frame()
    expect(f.count).toBe(made)
    expect(Array.from(f.positions).every(Number.isFinite)).toBe(true)
    world.step()
    expect(() => world.dispose()).not.toThrow()
  })
})

describe('lifecycle', () => {
  it('dispose is clean', () => {
    const s = scene(roller('c1', 0, 0.75, 0, 3, 0.5))
    const w1 = new SimWorld(Jolt, s)
    w1.spawnBoxAt(0, 1, 0, 0.15, 0.15, 0.15)
    for (let i = 0; i < 10; i++) w1.step()
    expect(() => w1.dispose()).not.toThrow()

    const w2 = new SimWorld(Jolt, s)
    w2.spawnBoxAt(0, 1, 0, 0.15, 0.15, 0.15)
    for (let i = 0; i < 10; i++) w2.step()
    const f = w2.frame()
    expect(f.count).toBe(1)
    expect(Number.isFinite(f.positions[1]!)).toBe(true)
    w2.dispose()
  })
})
