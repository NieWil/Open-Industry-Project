import initJolt from 'jolt-physics'
import { afterEach, describe, expect, it } from 'vitest'
import { clearPackages, registerPackage } from '../core/parts/partRegistry'
import type { PartPackage } from '../core/parts/partPackage'
import { ARC_END_EXT, BELT_FRICTION, CONVEYOR_FRICTION, FRAME_WALL_THICKNESS, GUARD_COLLISION_THICKNESS, GUARD_HEIGHT, SCENE_VERSION, DEFAULT_SIM_HZ } from '../core/types'
import type { SdkPart, PartInstance, SceneJSON } from '../core/types'
import { SimWorld } from './world'
import { PACKAGE_FORMAT } from '../core/parts/partPackage'

// SDK↔built-in sim parity regressions:
//  - an SDK belt's running surface must get BELT_FRICTION (0.5) everywhere a built-in belt would (lone deck,
//    curved arc deck, spur flat deck, and inside a merged deck cluster: deckFriction), while roller-family
//    SDK parts stay at CONVEYOR_FRICTION (0.8);
//  - a straight face-handle SDK conveyor must not deck-merge (it builds no cluster facets, so as the lowest-id
//    cluster owner it would starve the whole cluster of a deck and cargo would fall through);
//  - a spawner interlocked on an SDK curved conveyor must see its arc drive as "running" (omega, not sv);
//  - an SDK curved conveyor's guard colliders must include the straight ARC_END_EXT tangent stubs the visual has.

const Jolt = await initJolt()

// ---------- test packages (registered raw, like deckClusters.test.ts) ----------

/** a belt-like SDK part: declares a `path` handle, steps a linear surface velocity (the SDK belt shape) */
function sdkBeltPkg(): PartPackage {
  const params = {
    segments: { type: 'numberList', arity: 2, default: [[4, 0]], handle: { kind: 'path', lengthCol: 0, tiltCol: 1 } },
    width: { type: 'number', default: 0.6 },
    height: { type: 'number', default: 0.5 },
    speed: { type: 'number', default: 1.5 },
  }
  return {
    format: PACKAGE_FORMAT,
    id: 'test.belt',
    name: 'SDK Belt',
    conveyor: { bed: 'path', surface: 'belt' },
    params,
    behavior: `definePart({
      params: ${JSON.stringify(params)},
      step(ctx) { var s = ctx.params.speed; ctx.setSurfaceVelocity({ x: ctx.forward.x * s, y: 0, z: ctx.forward.z * s }) },
    })`,
    geometry: { kind: 'drawn', bounds: { length: 4, width: 0.6, top: 0.5 }, conveys: true },
  } as unknown as PartPackage
}

/** a curved SDK conveyor: an `arc`-handle sweep param + an arc-driving step; `finish` picks the drawn bed's look and
 *  the declared surface its grip (belt vs roller) */
function curvedPkg(id: string, finish: 'belt' | 'frame'): PartPackage {
  return {
    format: PACKAGE_FORMAT,
    id,
    name: 'SDK Curve', conveyor: { bed: 'arc', surface: finish === 'belt' ? 'belt' : 'roller', speedParam: 'speed' },
    params: {
      innerRadius: { type: 'number', default: 0.5 },
      width: { type: 'number', default: 1.524 },
      sweepDeg: { type: 'number', default: 90, handle: { kind: 'arc', innerRadiusParam: 'innerRadius', widthParam: 'width' } },
      speed: { type: 'number', default: 2 },
    },
    behavior: `definePart({
      params: {
        innerRadius: { type: 'number', default: 0.5 },
        width: { type: 'number', default: 1.524 },
        sweepDeg: { type: 'number', default: 90 },
        speed: { type: 'number', default: 2 },
      },
      geometry(g) { return [{ desc: g.sweep([[-0.05, -0.5], [-0.05, 0.5], [0, 0.5], [0, -0.5]], [[0, 0, 0], [1, 0, 0]]), finish: '${finish}' }] },
      step(ctx) {
        var rc = ctx.params.innerRadius + ctx.params.width / 2
        ctx.setArcSurfaceVelocity({ center: { x: ctx.position.x, z: ctx.position.z }, omega: ctx.params.speed / rc })
      },
    })`,
    geometry: { kind: 'drawn', bounds: { length: 2.274, width: 2.274, top: 0.5 }, conveys: true },
  } as unknown as PartPackage
}

/** a true SDK spur (length face handle declares the splay params): a finish:'belt' bed + one collision:'box'
 *  guard per side whose run honours host-fed `guardExtents` rows - the fixture twin of oip.spur-conveyor */
function sdkSpurPkg(): PartPackage {
  return {
    format: PACKAGE_FORMAT,
    id: 'test.sdkspur',
    name: 'SDK Spur', conveyor: { bed: 'spur', surface: 'belt', speedParam: 'speed' },
    params: {
      length: { type: 'number', default: 2, handle: { kind: 'face', axis: 'x', angleFrontParam: 'angleFrontDeg', angleBackParam: 'angleBackDeg' } },
      width: { type: 'number', default: 0.6, handle: { kind: 'face', axis: 'z' } },
      angleFrontDeg: { type: 'number', default: 0 },
      angleBackDeg: { type: 'number', default: 0 },
      speed: { type: 'number', default: 0 },
      guardExtents: { type: 'numberList', arity: 3, default: [] },
    },
    behavior: `definePart({
      params: {
        length: { type: 'number', default: 2 },
        width: { type: 'number', default: 0.6 },
        angleFrontDeg: { type: 'number', default: 0 },
        angleBackDeg: { type: 'number', default: 0 },
        speed: { type: 'number', default: 0 },
        guardExtents: { type: 'numberList', arity: 3, default: [] },
      },
      geometry(g, p) {
        var hw = p.width / 2, D = Math.PI / 180
        var tf = Math.tan(p.angleFrontDeg * D), tb = Math.tan(p.angleBackDeg * D)
        var parts = [{ desc: g.sweep([[-0.05, -hw], [-0.05, hw], [0, hw], [0, -hw]], [[0, 0, 0], [1, 0, 0]]), finish: 'belt' }]
        var ext = Array.isArray(p.guardExtents) ? p.guardExtents : []
        for (var s = 0; s < 2; s++) {
          var sign = s === 0 ? -1 : 1, zE = sign * hw
          var bE = -p.length / 2 + tb * zE, fE = p.length / 2 + tf * zE
          for (var i = 0; i < ext.length; i++) if (ext[i][0] === sign) { bE = ext[i][1]; fE = ext[i][2] }
          parts.push({ desc: g.box([Math.max(fE - bE, 0.01), 0.3, 0.01], [(bE + fE) / 2, 0.15, sign * (hw + 0.005)]), finish: 'guard', collision: 'box', sideGuard: sign < 0 ? 'left' : 'right' })
        }
        return parts
      },
      step(ctx) { var s = ctx.params.speed; ctx.setSurfaceVelocity({ x: ctx.forward.x * s, y: 0, z: ctx.forward.z * s }) },
    })`,
    geometry: { kind: 'drawn', bounds: { length: 2, width: 0.6, top: 0.5 }, conveys: true },
  } as unknown as PartPackage
}

/** a straight face-handle SDK conveyor (the spur shape): conveys, length/width face handles, finish:'belt' bed */
function spurPkg(): PartPackage {
  return {
    format: PACKAGE_FORMAT,
    id: 'test.spur',
    name: 'SDK Spur', conveyor: { bed: 'straight', surface: 'belt', speedParam: 'speed' },
    params: {
      length: { type: 'number', default: 4, handle: { kind: 'face', axis: 'x' } },
      width: { type: 'number', default: 0.6, handle: { kind: 'face', axis: 'z' } },
      speed: { type: 'number', default: 1.5 },
    },
    behavior: `definePart({
      params: { length: { type: 'number', default: 4 }, width: { type: 'number', default: 0.6 }, speed: { type: 'number', default: 1.5 } },
      geometry(g) { return [{ desc: g.sweep([[-0.05, -0.3], [-0.05, 0.3], [0, 0.3], [0, -0.3]], [[0, 0, 0], [1, 0, 0]]), finish: 'belt' }] },
      step(ctx) { var s = ctx.params.speed; ctx.setSurfaceVelocity({ x: ctx.forward.x * s, y: 0, z: ctx.forward.z * s }) },
    })`,
    geometry: { kind: 'drawn', bounds: { length: 4, width: 0.6, top: 0.1 }, conveys: true },
  } as unknown as PartPackage
}

// ---------- scene helpers ----------

/** an SDK belt (the `test.belt` path-handle fixture) at world (x, 2, z) - the "real belt" foil in the cluster/starve tests. Its deck facets merge into a butted cluster like any belt. */
function sdkBelt(id: string, x: number, z: number, speed = 2): SdkPart {
  return sdkPart(id, 'test.belt', [x, 2, z], { segments: [[4, 0]], width: 0.6, height: 0.5, speed })
}

function sdkPart(id: string, packageId: string, pos: [number, number, number], params: Record<string, unknown>): SdkPart {
  return { id, type: 'part', packageId, position: pos, rotationY: 0, params } as unknown as SdkPart
}

function scene(...parts: PartInstance[]): SceneJSON {
  return { version: SCENE_VERSION, parts }
}

// ---------- sim introspection (the deck/guard bodies a part built) ----------

interface BodyLike {
  GetFriction(): number
  GetPosition(): { GetX(): number; GetY(): number; GetZ(): number }
}
function partBodies(w: SimWorld, id: string): BodyLike[] {
  const groups = (w as unknown as { partGroups: Map<string, { bodies: BodyLike[] }> }).partGroups
  return groups.get(id)?.bodies ?? []
}
/** the part's running-surface friction: guards are friction 0, so the max over its bodies is the deck's */
function deckFrictionOf(w: SimWorld, id: string): number {
  return Math.max(...partBodies(w, id).map((b) => b.GetFriction()))
}
function hasBodyAt(w: SimWorld, id: string, x: number, y: number, z: number, tol = 1e-3): boolean {
  return partBodies(w, id).some((b) => {
    const p = b.GetPosition()
    return Math.abs(p.GetX() - x) < tol && Math.abs(p.GetY() - y) < tol && Math.abs(p.GetZ() - z) < tol
  })
}

describe('SDK conveyor sim parity (friction / clusters / interlock / curved guards)', () => {
  let world: SimWorld | null = null
  afterEach(() => {
    world?.dispose()
    world = null
    clearPackages()
  })

  it('a lone SDK belt deck gets BELT_FRICTION, not roller friction', () => {
    registerPackage(sdkBeltPkg())
    world = new SimWorld(Jolt, scene(sdkPart('b1', 'test.belt', [0, 1, 0], { segments: [[4, 0]], width: 0.6, height: 0.5, speed: 1.5 })))
    expect(deckFrictionOf(world, 'b1')).toBeCloseTo(BELT_FRICTION, 6)
  })

  it('an SDK curved belt (finish:"belt" bed) gets BELT_FRICTION; a curved non-belt stays at roller friction', () => {
    registerPackage(curvedPkg('test.curve', 'belt'))
    registerPackage(curvedPkg('test.curveroller', 'frame'))
    world = new SimWorld(
      Jolt,
      scene(
        sdkPart('cb', 'test.curve', [0, 1, 0], { innerRadius: 0.5, width: 1.524, sweepDeg: 90, speed: 2 }),
        sdkPart('cr', 'test.curveroller', [10, 1, 0], { innerRadius: 0.5, width: 1.524, sweepDeg: 90, speed: 2 }),
      ),
    )
    expect(deckFrictionOf(world, 'cb')).toBeCloseTo(BELT_FRICTION, 6)
    expect(deckFrictionOf(world, 'cr')).toBeCloseTo(CONVEYOR_FRICTION, 6)
  })

  it('an SDK belt inside a merged deck cluster does not poison the compound to roller friction', () => {
    registerPackage(sdkBeltPkg())
    // SDK belt 'a' (front end at world x = 2.0) butted by the SDK belt 'b' (back end at 2.25 − pulley 0.25):
    // 'a' is the lowest-id cluster owner and builds the one merged compound for both members.
    world = new SimWorld(
      Jolt,
      scene(sdkBelt('a', -2.25, 0), sdkPart('b', 'test.belt', [2.25, 2, 0], { segments: [[4, 0]], width: 0.6, height: 0.5, speed: 1.5 })),
    )
    expect(deckFrictionOf(world, 'a')).toBeCloseTo(BELT_FRICTION, 6) // all-belt cluster keeps the belt grip
  })

  it('a straight face-handle SDK conveyor leaves a butted cluster its deck (cargo rests, not falls)', () => {
    registerPackage(spurPkg())
    registerPackage(sdkBeltPkg())
    // spur 'a' (id < 'b') centre-origin at x=4: its back end butts the belt's front end at x = 2.0. If it were
    // mergeable it would own the cluster but never build the merged deck (its deck comes from the scripted flat
    // path) - the belt member early-returns and cargo dropped on the belt falls straight through.
    world = new SimWorld(Jolt, scene(sdkPart('a', 'test.spur', [4, 2, 0], { length: 4, width: 0.6, speed: 1.5 }), sdkBelt('b', -2.25, 0, 0)))
    world.spawnBoxAt(0, 2.3, 0, 0.15, 0.15, 0.15)
    for (let i = 0; i < DEFAULT_SIM_HZ * 2; i++) world.step()
    const f = world.frame()
    expect(f.count).toBe(1) // not culled - the belt built its own deck
    expect(f.positions[1]!).toBeGreaterThan(1.5) // resting on the belt surface (y ≈ 2), not fallen through
    // and the spur's own flat deck is a belt surface (finish:'belt' bed → BELT_FRICTION on the fallback path)
    expect(deckFrictionOf(world, 'a')).toBeCloseTo(BELT_FRICTION, 6)
  })

  it('an SDK curved conveyor records its arc drive as a nonzero interlock speed (a spawner interlock sees it running)', () => {
    registerPackage(curvedPkg('test.curve', 'belt'))
    world = new SimWorld(
      Jolt,
      scene(sdkPart('curve', 'test.curve', [0, 1, 0], { innerRadius: 0.5, width: 1.524, sweepDeg: 90, speed: 2 })),
    )
    world.step()
    // the behavior commands arc omega (rad/s) - the recorded interlock speed (read by ctx.conveyorRunning for a
    // spawner's "pause when stopped") must be nonzero while it runs, not 0 (which would falsely read "stopped")
    const speeds = (world as unknown as { conveyorSpeeds: Map<string, number> }).conveyorSpeeds
    expect(Math.abs(speeds.get('curve') ?? 0)).toBeGreaterThan(0.1)
  })

  it("an SDK curved conveyor's guard colliders include the straight tangent stubs at both ends", () => {
    registerPackage(curvedPkg('test.curve', 'belt'))
    const part = sdkPart('c', 'test.curve', [0, 2, 0], { innerRadius: 0.5, width: 1.524, sweepDeg: 90, speed: 2 })
    world = new SimWorld(Jolt, scene(part))
    // Guard-wall stub radii are face-based: the rail's face sits at the bed edge ± FRAME_WALL_THICKNESS (the
    // straight convention, and where this part's visual guard is drawn), so the box centre is a further
    // half-thickness away from the bed. A box centre on the face radius would lean both rails into the bed,
    // losing usable width on a curve vs a straight of the same width.
    const T = GUARD_COLLISION_THICKNESS / 2
    const gri = 0.5 - FRAME_WALL_THICKNESS - T // inner guard-wall centre radius (face at 0.5 − wall)
    const gro = 0.5 + 1.524 + FRAME_WALL_THICKNESS + T // outer guard-wall centre radius
    const cy = 2 + (GUARD_HEIGHT - 0.005) / 2 // guard-wall centre height
    const half = ARC_END_EXT / 2
    // guard walls exist at all (the chord walls over the sweep) - the arc midpoint chord of the outer wall
    expect(partBodies(world, 'c').length).toBeGreaterThan(4)
    for (const gr of [gri, gro]) {
      // back stub: at the inlet P(0) = (gr, 0), extending upstream (+Z) by ARC_END_EXT
      expect(hasBodyAt(world, 'c', gr, cy, half)).toBe(true)
      // front stub (sweep 90°): at the outlet P(π/2) = (0, −gr), extending downstream (−X) by ARC_END_EXT
      expect(hasBodyAt(world, 'c', -half, cy, -gr)).toBe(true)
    }
  })

  it('an SDK spur gets a parallelogram hull deck - cargo rests on the splay overhang past ±length/2', () => {
    registerPackage(sdkSpurPkg())
    // 45° front splay, width 1.0: the +Z edge reaches x = 1 + tan45·0.5 = 1.5, half a metre past the
    // rectangle a flat length×width fallback deck would cover. Drop a box entirely inside the overhang
    // triangle (x ∈ [1.02, 1.22]); a flat deck would let it fall straight through to the floor.
    world = new SimWorld(Jolt, scene(sdkPart('sp', 'test.sdkspur', [0, 2, 0], { length: 2, width: 1.0, angleFrontDeg: 45, angleBackDeg: 0, speed: 0 })))
    world.spawnBoxAt(1.12, 2.3, 0.38, 0.1, 0.1, 0.1)
    for (let i = 0; i < DEFAULT_SIM_HZ * 2; i++) world.step()
    const f = world.frame()
    expect(f.count).toBe(1)
    expect(f.positions[1]!).toBeGreaterThan(1.5) // resting on the hull overhang (y ≈ 2.1), not the floor
    // and the finish:'belt' bed keeps the belt grip on the hull path (built-in spur_belt_conveyor parity)
    expect(deckFrictionOf(world, 'sp')).toBeCloseTo(BELT_FRICTION, 6)
  })

  it('a box driven into an SDK spur flank is walled, not dragged across the sheared bed', () => {
    registerPackage(sdkSpurPkg())
    registerPackage(spurPkg())
    // Running-surface split: surface velocity belongs to the deck's top, so a box that meets the spur's side
    // must stop, not get carried along the flow. Spur deck top 0.75 (hull 0.60..0.75) running +X; the feeder
    // conveys +Z into its −Z flank and sits low enough (box top 0.74) that the box can only hit the side.
    const sp = sdkPart('sp', 'test.sdkspur', [0, 0.75, 0], { length: 2, width: 0.6, angleFrontDeg: 0, angleBackDeg: 0, speed: 1.5 })
    const feed = sdkPart('feed', 'test.spur', [0, 0.44, -1.2], { length: 2, width: 0.6, speed: 1 })
    feed.rotationY = -Math.PI / 2
    world = new SimWorld(Jolt, scene(sp, feed))
    world.spawnBoxAt(0, 0.59, -1.8, 0.15, 0.15, 0.15) // rests on the feeder (bottom 0.44), rides +Z into the flank
    const x0 = world.frame().positions[0]!
    let maxAbsDx = 0
    for (let i = 0; i < DEFAULT_SIM_HZ * 4; i++) {
      world.step()
      maxAbsDx = Math.max(maxAbsDx, Math.abs(world.frame().positions[0]! - x0))
    }
    expect(world.frame().positions[1]!).toBeGreaterThan(0.3) // still up on the feeder (not a vacuous pass)
    expect(maxAbsDx).toBeLessThan(0.1) // never carried along the spur's +X flow by its flank
  })

  it("an SDK spur's guard colliders extend to the host wall it merges onto (guardExtents fold)", () => {
    registerPackage(sdkSpurPkg())
    registerPackage(spurPkg())
    // host: an SDK straight conveyor along X (centre-origin bed world x∈[0,4], outer wall plane z = 0.31 - the
    // extent value is a ray hit on that z-plane, independent of the host's X origin). The spur (centre-origin,
    // square ends, rot +90° so its front points at the wall) sits 0.1 short → extents extend both fronts to local x=1.1.
    const host = sdkPart('host', 'test.spur', [2, 0.75, 0], { length: 4, width: 0.6, speed: 0 })
    const sp = sdkPart('sp', 'test.sdkspur', [2, 0.75, 1.41], { length: 2, width: 0.6, angleFrontDeg: 0, angleBackDeg: 0, speed: 0 })
    sp.rotationY = Math.PI / 2
    world = new SimWorld(Jolt, scene(host, sp))
    // extended guard run −1..1.1 → box centre local (x 0.05, y 0.15, z ±0.325); at rot 90° the world
    // centre is (2 ± 0.325, 0.9, 1.41 − 0.05). An unextended guard would sit at world z = 1.41 exactly -
    // that z is what this test is about; the lateral ±0.325 is incidental.
    // The lateral figure is ±0.325, not the authored ±0.305, because guardColliderCrossSection normalizes a
    // guard collider to GUARD_COLLISION_THICKNESS: this package authors 0.01 thick (half 0.005), so the box
    // grows to half 0.025 and its centre moves outward by 0.020. The inner face cargo rides is unmoved at
    // 0.300 - growth is outward-only, which is the whole contract (core/geometry/collisionShapes.ts).
    expect(hasBodyAt(world, 'sp', 2 - 0.325, 0.9, 1.36)).toBe(true)
    expect(hasBodyAt(world, 'sp', 2 + 0.325, 0.9, 1.36)).toBe(true)
  })
})
