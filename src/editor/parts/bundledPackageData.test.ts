import { describe, expect, it } from 'vitest'
import type { PackageManifest } from '../../sim/buildPackage'
import { validatePartPackage, validateSnapParamRefs } from '../../core/parts/partValidate'
import type { SnapSpec } from '../../core/parts/partApi'
import { clearPackages, registerPackage } from '../../core/parts/partRegistry'
import { evalPartGeometry } from '../../core/geometry/geometryEval'
import { findSnap } from '../../core/snap/snapFeatures'
import { SNAP_FENCE_VISIBLE_THRESHOLD, SNAP_VISIBLE_THRESHOLD } from '../../core/types'
import type { PartInstance } from '../../core/types'
import { ORDER, mergeBundleOrder } from './bundledExamples'
import { bundledPackagesFromData, bundledPartData } from './bundledPackageData'
import type { BundledPartData } from './bundledPackageData'
import { CELL } from '../demo/demoScenes'

// The committed part-package files (examples/parts/<dir>/{rig.json, behavior.ts}) are the only source of the
// first-party catalog, so this pins the loader itself: it pairs a manifest + behavior per folder, every one builds
// into a valid package, and the curated order only references real folders.

const dataIds = new Set(bundledPartData().map((d) => d.manifest.id))

describe('committed part-package loader (the first-party catalog source)', () => {
  it('pairs a manifest + behavior for every committed folder', () => {
    const data = bundledPartData()
    expect(data.length).toBeGreaterThanOrEqual(ORDER.length) // at least the whole curated catalog
    for (const d of data) {
      expect(d.behavior).toContain('definePart(')
      expect(d.manifest.id).toMatch(/^oip\./)
    }
  })

  it('every committed part builds into a structurally valid package', () => {
    for (const pkg of bundledPackagesFromData()) expect(validatePartPackage(pkg)).toEqual([])
  })

  // The blade-stop / chain-transfer convergence parts reach built-in track-snap parity by declaring snap.track
  // in their behavior.ts. Guard that the live bundled-bake path (buildPackage → validatePart → declarations())
  // actually surfaces that block onto the registered package - snapFeatures reads it via getPackage().snap.track,
  // so a silent drop here would make the SDK parts stop snapping onto roller beds while every other test (which
  // registers a synthetic package) stays green. See docs/part-authoring-guide.md and snapFeatures.test.ts.
  it('the blade-stop and chain-transfer bundles carry their snap.track (roller-bed parity)', () => {
    const byId = new Map(bundledPackagesFromData().map((p) => [p.id, p]))
    const blade = byId.get('oip.blade-stop')
    expect(blade?.snap?.track, 'blade stop must declare a track seat').toBeTruthy()
    expect(blade!.snap!.track!.fitWidthParam).toBe('width') // auto-fit the usable bed width
    expect(blade!.snap!.track!.lanes).toBeUndefined() // single-point gap anchor, not a lane bank

    const chain = byId.get('oip.chain-transfer')
    expect(chain?.snap?.track?.lanes, 'chain transfer must declare lane-parity anchoring').toBeTruthy()
    expect(chain!.snap!.track!.lanes!.countParam).toBe('chains')
    expect(chain!.snap!.track!.lanes!.pitchParam).toBe('distance') // adopt host roller pitch
    expect(chain!.snap!.track!.fitWidthParam).toBe('laneLength')
    // …and it seats recessed, not flush. The chain transfer's `conveys` deck rides the pop-up lift joint, so a
    // flush seat would leave two powered surfaces coplanar on the host bed: cargo touches both, and whichever is
    // idle brakes it (a surface velocity of zero is a stopped belt, not neutral). Down, the host rollers alone
    // carry; the 0.095 m stroke then lifts the load clear. demoScenes also places this offset by hand
    // (CELL.chainDropZ), and the two must stay equal.
    expect(chain!.snap!.track!.targetLocalY, 'chain transfer must rest BELOW the roller line').toBeLessThan(0)
    expect(chain!.snap!.track!.targetLocalY).toBeCloseTo(-0.03, 10)
    // the pop-up must still clear the rollers it rests below (stroke 0.095 > recess)
    expect(0.095 + chain!.snap!.track!.targetLocalY!).toBeGreaterThan(0.05)
    // the blade stop is not recessed: it rises through a roller gap from its own seat at bed level
    expect(blade!.snap!.track!.targetLocalY ?? 0).toBe(0)
    // …and the hand-placed demo cell seats its transfer at the same depth, so a snapped cell and the authored one
    // agree. If the snap seated flush while the cell dropped 0.03, a drag-and-drop would produce the one
    // configuration demoScenes was written to avoid.
    expect(chain!.snap!.track!.targetLocalY).toBeCloseTo(-CELL.chainDropZ, 10)
  })

  // Same class of silent drop, the barrier family: fence / safety gate / guard rail reach barrier-chaining parity
  // (docs/part-snap-chain.md) by declaring snap.chain in their behavior.ts. Every chain test registers a synthetic
  // package, so without the declaration the whole family snaps to nothing while the suite stays green. Pin the
  // declarations and the family split: a fence and a gate share one group (a gate is a door in a
  // fence line), a guard rail is its own and never joins them.
  it('the barrier bundles carry their snap.chain (fence + gate share a group; guard rail does not)', () => {
    const byId = new Map(bundledPackagesFromData().map((p) => [p.id, p]))
    const chainOf = (id: string) => {
      const c = byId.get(id)?.snap?.chain
      expect(c, `${id} must declare a chain snap`).toBeTruthy()
      return c!
    }
    const fence = chainOf('oip.fence')
    const gate = chainOf('oip.safety-gate')
    const rail = chainOf('oip.guard-rail')
    for (const c of [fence, gate, rail]) {
      expect(c.lengthParam).toBe('length')
      // the L-corner handshake needs both post params, or the shared corner post draws twice
      expect(c.omitStartParam).toBe('omitPostStart')
      expect(c.omitEndParam).toBe('omitPostEnd')
    }
    expect(gate.group, 'a gate is a door IN a fence line').toBe(fence.group)
    expect(rail.group).not.toBe(fence.group)
    // two engage distances: a fence family tight, a guard rail loose
    expect(fence.reach).toBeCloseTo(SNAP_FENCE_VISIBLE_THRESHOLD, 10)
    expect(gate.reach).toBeCloseTo(SNAP_FENCE_VISIBLE_THRESHOLD, 10)
    expect(rail.reach).toBeCloseTo(SNAP_VISIBLE_THRESHOLD, 10)
  })

  // …and the declaration actually snaps, through the live registry the editor uses. The check above would pass on
  // a block the bake dropped downstream; this one drops a real gate beside a real fence and reads the pose.
  it('a bundled safety gate chains onto a bundled fence (collinear + L-corner handshake)', () => {
    clearPackages()
    for (const pkg of bundledPackagesFromData()) registerPackage(pkg)
    const at = (id: string, packageId: string, x: number, z: number, rotationY: number, length: number): PartInstance =>
      ({ id, type: 'part', packageId, position: [x, 0, z], rotationY, params: { length, omitPostStart: false, omitPostEnd: false } }) as unknown as PartInstance
    const fence = at('f', 'oip.fence', 0, 0, 0, 4) // 4 m fence centred at the origin, running along +X
    const gate = at('g', 'oip.safety-gate', 99, 99, 0, 1)

    // dropped just off the fence's +X end → butts flush, no shared corner post
    const straight = findSnap(gate, { position: [2.6, 0, 0.08], rotationY: 0.05 }, [fence])
    expect(straight, 'a gate dropped off a fence end must chain').not.toBeNull()
    expect(straight!.pose.position[0]).toBeCloseTo(2.5, 9) // fence half 2 + gate half 0.5
    expect(straight!.pose.position[2]).toBeCloseTo(0, 9)
    expect(straight!.paramOverrides).toEqual({ omitPostStart: false, omitPostEnd: false })

    // dropped perpendicular at the same end → L-corner: the gate omits its mating post, the fence un-omits the
    // end they now share, so the corner post draws once
    const corner = findSnap(gate, { position: [2.0, 0, 0.45], rotationY: Math.PI / 2 - 0.1 }, [fence])
    expect(corner, 'a perpendicular drop must form an L-corner').not.toBeNull()
    expect(corner!.pose.rotationY).toBeCloseTo(Math.PI / 2, 9)
    expect(corner!.paramOverrides).toEqual({ omitPostStart: false, omitPostEnd: true })
    expect(corner!.targetParamOverrides).toEqual({ omitPostEnd: false })

    // cross-group isolation survives the real packages: a guard rail never joins the fence line
    const rail = at('r', 'oip.guard-rail', 99, 99, 0, 4)
    expect(findSnap(rail, { position: [4.1, 0, 0.05], rotationY: 0 }, [fence])).toBeNull()
    clearPackages()
  })

  // The declaration is the feature. snapFeatures.test.ts proves every snap kind the engine dispatches against a
  // synthetic package, which shows the kind works but never that a shipped part asks for it. This guards against
  // a shipped part missing its block: a barrier family with no `snap` block snaps to nothing while ~2300 specs
  // pass, and a platform without the `tile` block its own doc says it carries leaves two decks side by side
  // unsnapped.
  //
  // So this is the ledger: one entry per SnapSpec field, in one of three states. Typed as
  // Record<keyof SnapSpec, …>, so adding a field to SnapSpec is a compile error here until it gets an entry.
  //
  //   '<part id>'  the shipped part that owns the kind. Must really declare it.
  //   SDK_ONLY     a real SDK capability with no first-party user by design. Must have no declarer, so
  //                quietly declaring one later fails here and forces the note below to be updated.
  //   null         nobody has decided yet. Always fails, so a new kind cannot be parked here.
  //
  // The three states keep apart two meanings of "no shipped part declares this": a decision, or a gap nobody
  // noticed. Only the second is a bug.
  const SDK_ONLY = Symbol('sdk-only: a real capability with no first-party user')
  type SnapOwner = string | typeof SDK_ONLY | null
  const SNAP_KIND_OWNER: Record<keyof SnapSpec, SnapOwner> = {
    mounts: 'oip.laser-sensor', //      a device seating on a host surface (sensors, diverter, push button)
    surfaces: 'oip.platform', //        the host half - a rail/deck other parts mount onto
    track: 'oip.blade-stop', //         a seat anchored to a roller bed's rendered grid
    tile: 'oip.floor-marking', //       edge-to-edge structural tiling (markings; platform decks)
    chain: 'oip.guard-rail', //         end-to-end chaining of a linear part (barriers)
    flush: 'oip.rack', //               ambient face-flush for tiled parts (a row of racking)
    // Seating on a deck edge. Owned by the stairs: from package format 3 `stairMount` is an edgeMount facing
    // into the deck (docs/part-snap-cuts.md). Its other facing, a barrier along a platform rim, still has
    // no first-party user: the platform's own railing does that job better (parametric, reflows on
    // resize, takes per-side openings), so a hand-seated guard rail would duplicate it. See
    // docs/part-snap-edge-mount.md.
    edgeMount: 'oip.stairs', //         a flight climbing onto a deck edge, sized to the deck
    // (`ports` and `rails`, the two connector primitives, are retired: docs/part-snap-connectors.md.)
  }

  it('every snap kind the engine dispatches is owned, or deliberately SDK-only', () => {
    const pkgs = bundledPackagesFromData()
    const declarers = (kind: keyof SnapSpec): string[] => pkgs.filter((p) => p.snap?.[kind] !== undefined).map((p) => p.id)
    for (const [kind, owner] of Object.entries(SNAP_KIND_OWNER) as [keyof SnapSpec, SnapOwner][]) {
      const found = declarers(kind)
      if (owner === null) {
        expect.fail(`snap.${kind} has no ledger decision - name the shipped part that declares it, or mark it SDK_ONLY with the reason`)
      } else if (owner === SDK_ONLY) {
        expect(found, `snap.${kind} is recorded SDK_ONLY but ${found.join(', ')} declares it - give it an owner in SNAP_KIND_OWNER and update the note`).toEqual([])
      } else {
        expect(found, `snap.${kind} has NO shipped declarer - the engine path is dead code`).not.toEqual([])
        expect(found, `snap.${kind}'s recorded owner ${owner} no longer declares it`).toContain(owner)
      }
    }
  })

  // Every snap field that names a param must name a real one. The engine resolves these through numParamOf,
  // which returns null for a name that isn't there, and a null makes the snap return null - so a typo is a
  // part that silently never snaps. Authoring catches it for a hand-written part (validatePart); this is the
  // same check over the generated first-party catalog, where a builder edit is the way it would creep in.
  it('every snap param reference in the bundled catalog resolves to a real param', () => {
    for (const pkg of bundledPackagesFromData()) {
      expect(validateSnapParamRefs(pkg), `${pkg.id} has a dangling snap param reference`).toEqual([])
    }
  })

  // …and the platform's half of `tile` actually tiles, through the live registry (the synthetic-package twin
  // lives in snapFeatures.test.ts; this one catches a missing declaration).
  it('two bundled platforms of the same height abut deck-to-deck', () => {
    clearPackages()
    for (const pkg of bundledPackagesFromData()) registerPackage(pkg)
    const deck = (id: string, x: number, z: number, height = 2): PartInstance =>
      ({ id, type: 'part', packageId: 'oip.platform', position: [x, height, z], rotationY: 0,
         params: { length: 4, width: 4, height, color: '#f2bd0f', showRailings: true, showSupports: true } }) as unknown as PartInstance

    // a 4 m deck dropped just off another's +X edge butts flush: centres 4 m apart, junction on the shared edge
    const abut = findSnap(deck('m', 99, 99), { position: [4.2, 2, 0.1], rotationY: 0.03 }, [deck('t', 0, 0)])
    expect(abut, 'two decks side by side must tile').not.toBeNull()
    expect(abut!.pose.position[0]).toBeCloseTo(4, 9)
    expect(abut!.pose.position[1]).toBeCloseTo(2, 9) // decks land coplanar
    expect(abut!.junction.x).toBeCloseTo(2, 9) // the cue sits on the shared edge

    // a deck of a different height does not tile - the height gate, the documented stepping-mezzanine non-goal
    expect(findSnap(deck('m', 99, 99, 3), { position: [4.2, 3, 0.1], rotationY: 0 }, [deck('t', 0, 0)])).toBeNull()
    clearPackages()
  })

  // The `flush` twin. Ambient flush is size-sensitive: it engages within 0.75 m, so it only belongs on a part
  // bigger than that gate. The rack (5.4 x 1.1) clears it; cargo such as box and pallet does not. Pin both
  // halves (the rack tiles, and the small parts stay out of the kind), so a well-meant "let boxes tile too"
  // fails a test instead of shipping.
  it('two bundled racks tile flush, and cargo stays out of the kind', () => {
    clearPackages()
    for (const pkg of bundledPackagesFromData()) registerPackage(pkg)
    const rack = (id: string, x: number, z: number): PartInstance =>
      ({ id, type: 'part', packageId: 'oip.rack', position: [x, 0, z], rotationY: 0, params: {} }) as unknown as PartInstance

    // dropped just off the target's +Z face → butts flush, shoulder to shoulder down an aisle row
    const beside = findSnap(rack('m', 99, 99), { position: [0.1, 0, 1.3], rotationY: 0.02 }, [rack('t', 0, 0)])
    expect(beside, 'a rack dropped beside a rack must tile').not.toBeNull()
    expect(beside!.pose.position[2]).toBeCloseTo(1.1, 9) // depth 1.1 → flush centres 1.1 apart
    // …and off the +X end → flush along the run
    const end = findSnap(rack('m', 99, 99), { position: [5.6, 0, 0.1], rotationY: 0 }, [rack('t', 0, 0)])
    expect(end!.pose.position[0]).toBeCloseTo(5.4, 9) // width 5.4

    // cargo must not carry the kind: at 0.6 x 0.4 a box is smaller than the 0.75 m engage, so ambient flush
    // would yank one dropped in plain air beside another. Guard the declaration, not just the behaviour.
    const byId = new Map(bundledPackagesFromData().map((p) => [p.id, p]))
    for (const id of ['oip.box', 'oip.pallet']) {
      expect(byId.get(id)?.snap?.flush, `${id} is smaller than the 0.75 m ambient engage and must not declare flush`).toBeUndefined()
    }
    clearPackages()
  })

  it('every id in the curated ORDER is a real committed folder', () => {
    for (const id of ORDER) expect(dataIds.has(id), `ORDER id ${id} has no committed folder`).toBe(true)
  })

  // The in-scene teach-by-pose gizmo (joint rings + IK handle, shown on selection) is opt-in via geometry.posable.
  // Only manipulators you hand-teach should carry it; a rig whose joints are sim/PLC-driven must not, or selecting
  // the placed part draws an interactive pose gizmo the operator can't use. This pins that split across the catalog
  // so a new/edited part can't silently regain (or lose) the affordance. See sdkPart.buildRigGizmo.
  it('only the hand-taught manipulators opt into the in-scene pose gizmo (geometry.posable)', () => {
    const posableIds = new Set(['oip.six-axis-robot', 'oip.gantry', 'oip.agv'])
    for (const pkg of bundledPackagesFromData()) {
      if (pkg.geometry.kind !== 'rig') continue
      const on = pkg.geometry.posable === true
      if (posableIds.has(pkg.id)) expect(on, `${pkg.id} is a manipulator and must set posable`).toBe(true)
      else expect(on, `${pkg.id} is sim/PLC-driven and must NOT set posable`).toBe(false)
    }
  })
})

// mergeBundleOrder: order fixes catalog position; a committed folder not in order (a freshly-dropped part) still
// loads, appended after the curated set in stable order (Gap 2 - drop-a-folder).
describe('mergeBundleOrder - ORDER positions the catalog; new folders still load', () => {
  const mk = (id: string): BundledPartData => ({
    dir: id,
    manifest: { id, name: id, geometry: { kind: 'drawn', conveys: false, bounds: { length: 1, width: 1, top: 1 } } } as PackageManifest,
    behavior: '',
  })
  const ids = (xs: BundledPartData[]): string[] => xs.map((x) => x.manifest.id)

  it('orders committed folders by ORDER, regardless of the data array order', () => {
    expect(ids(mergeBundleOrder([mk('c'), mk('a'), mk('b')], ['a', 'b', 'c']))).toEqual(['a', 'b', 'c'])
  })

  it('appends a folder that is not in ORDER after the curated set (drop-a-folder)', () => {
    expect(ids(mergeBundleOrder([mk('new'), mk('a'), mk('c')], ['a', 'c']))).toEqual(['a', 'c', 'new'])
  })

  it('keeps stable data order among unlisted folders', () => {
    expect(ids(mergeBundleOrder([mk('z'), mk('y'), mk('a')], ['a']))).toEqual(['a', 'z', 'y'])
  })
})

// ---- a rig label has to stand off the housing it is printed on --------------------------------------------
const pushButton = bundledPartData().find((d) => d.manifest.id === 'oip.push-button')!
const pbLabel = (pushButton.manifest.geometry as unknown as { links: { name: string; shape: Record<string, unknown>; offset?: number[] }[] }).links.find((l) => l.name === 'label')!

// A `label` link is a flat plane, but the housing it sits on is not flat: its front steps and slopes back as it
// rises (the legend plate, the bezel, the bolt heads all stand at different depths). This guards against a
// caption at z 0.039 on a face that runs 0.0454 → 0.0345 through its footprint: its lower half is inside the
// housing, its middle exactly coplanar, and only its top edge in clear air. Such a legend is part missing and part
// z-fighting, flickers as the camera moves, and reads as no caption at all past a couple of metres. Nothing else
// can catch it: a label is render-only, so it touches no sim body, no collision shape, no draw budget.
//
// So this asserts the one thing that cannot be checked by reading the rig alone: measured against the
// housing as drawn (the part's own geometry(), which is what renders - the button is code-built), the caption plane
// clears every surface under it. It re-derives from the geometry rather than pinning the numbers to themselves, so
// it also fails if the housing is changed out from under the caption.
describe('Push Button caption clearance (measured against the drawn housing)', () => {
  /** every vertex geometry() draws, in the part's own space; the cap's are tagged 'cap' (it rides the cap link) */
  function drawnVertices(): { node: string; p: [number, number, number] }[] {
    return drawnTriangles().flatMap((t) => t.p.map((p) => ({ node: t.node, p })))
  }
  /** every triangle geometry() draws - a face is measured by its surface, not only its corners, since a flat face
   *  can span the caption's footprint with no vertex inside it */
  function drawnTriangles(): { node: string; p: [number, number, number][] }[] {
    const parts = evalPartGeometry(pushButton.behavior, {}) ?? []
    return parts.flatMap((part) => {
      const a = part.desc.positions
      const at = (i: number): [number, number, number] => [a[i * 3]!, a[i * 3 + 1]!, a[i * 3 + 2]!]
      const out: { node: string; p: [number, number, number][] }[] = []
      const ix = part.desc.indices
      for (let t = 0; t + 2 < ix.length; t += 3) out.push({ node: part.link ?? part.material ?? 'housing', p: [at(ix[t]!), at(ix[t + 1]!), at(ix[t + 2]!)] })
      return out
    })
  }

  it('the caption plane stands clear of every housing surface inside its own footprint', () => {
    const lab = pbLabel.shape as { size: [number, number] }
    const [w, h] = lab.size
    const [ox = 0, oy = 0, oz = 0] = pbLabel.offset!
    const halfW = w / 2 + 0.002 // a small margin: a surface just outside the plate would still be seen against it
    const halfH = h / 2 + 0.002
    let frontmost = -Infinity
    let owner = ''
    // any triangle whose extent overlaps the footprint counts, at its frontmost point (conservative for a slope)
    for (const t of drawnTriangles()) {
      const xs = t.p.map((p) => p[0]), ys = t.p.map((p) => p[1])
      if (Math.max(...xs) < ox - halfW || Math.min(...xs) > ox + halfW) continue
      if (Math.max(...ys) < oy - halfH || Math.min(...ys) > oy + halfH) continue
      const z = Math.max(...t.p.map((p) => p[2]))
      if (z > frontmost) { frontmost = z; owner = t.node }
    }
    expect(frontmost).toBeGreaterThan(-Infinity) // the footprint must actually be on the housing
    // 1 mm is already far outside any depth-buffer resolution at the ranges this scene is viewed from; the
    // authored standoff is ~3 mm. A caption at or behind the surface is the bug this exists to catch.
    expect(oz - frontmost, `caption z ${oz} vs frontmost housing z ${frontmost.toFixed(4)} (${owner})`).toBeGreaterThan(0.001)
  })

  it('the caption sits above the cap, not over it', () => {
    const lab = pbLabel.shape as { size: [number, number] }
    const capTop = Math.max(...drawnVertices().filter((v) => v.node === 'cap').map((v) => v.p[1]))
    expect(capTop).toBeGreaterThan(0) // the cap is drawn
    expect((pbLabel.offset![1] ?? 0) - lab.size[1] / 2).toBeGreaterThan(capTop)
  })
})

// --- Inspector tooltips: the doc line a part carries for each of its params ---
//
// A param's description lives on the param (the SDK's ParamSpec.desc) and rides into the Inspector hover via
// schemaToParamSpecs. A host-side table keyed by part type goes silently dead once a part is a package: every
// equipment tooltip loses its description and nothing notices. So the parts that are documented are pinned here:
// a builder edit that drops a desc fails instead of quietly un-documenting a field.
//
// Every first-party part is documented, so this is a gate rather than an allowlist: a new part, or a new param
// on an existing one, fails here until it says what it does. There is no opt-out list - the whole
// failure mode being guarded is a description going missing without anyone noticing.
describe('param descriptions on the bundled parts', () => {
  it('every bundled part describes each of its visible params', () => {
    const undocumented: string[] = []
    for (const pkg of bundledPackagesFromData()) {
      for (const [key, spec] of Object.entries(pkg.params)) {
        if (!spec || spec.hidden) continue // a hidden param has no field to hover, so nothing to explain
        if (!(typeof spec.desc === 'string' && spec.desc.length > 0)) undocumented.push(`${pkg.id}.${key}`)
      }
    }
    // report the whole list, not just the first: adding a part usually adds several at once
    expect(undocumented, `params with no desc:\n  ${undocumented.join('\n  ')}`).toEqual([])
  })

  // A description that merely repeats the label costs a hover and teaches nothing. This can't judge prose, but
  // it can catch the degenerate case of pasting the label in.
  it('no description is just its own label', () => {
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')
    for (const pkg of bundledPackagesFromData()) {
      for (const [key, spec] of Object.entries(pkg.params)) {
        if (typeof spec?.desc !== 'string' || typeof spec.label !== 'string') continue
        expect(norm(spec.desc), `${pkg.id}.${key} restates its label`).not.toBe(norm(spec.label))
      }
    }
  })

  // The tooltip is user-facing copy, and this repo writes those with a plain hyphen (see the "In auto - PLC
  // controlled" prompt) - an em dash reads as typographic noise in the UI.
  it('no description uses an em dash', () => {
    for (const pkg of bundledPackagesFromData()) {
      for (const [key, spec] of Object.entries(pkg.params)) {
        if (typeof spec?.desc === 'string') expect(spec.desc, `${pkg.id}.${key}`).not.toContain('—')
      }
    }
  })
})
