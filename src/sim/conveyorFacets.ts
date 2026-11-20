// The conveyor surface-velocity table SimWorld's contact listeners read: every conveyor body's entries by body key,
// their body-local facet axes, and - on the forked build - the native listener's facet table that mirrors them.
// SimWorld registers a conveyor body here as it builds it, releases it with its part, and calls sync() once per step
// after the behaviors drove the entries and before the solver reads them. The gates and the listeners themselves
// live in conveyorContacts.ts.
import type Jolt from 'jolt-physics'
import type { ConveyorEntry } from '../core/geometry/collisionShapes'
import { allocFacets, CONVEYOR_TAG, createConveyorContactListener, FACET_CAPACITY, FACET_STRIDE, FLANK_PROTECT_COS, freeFacets, FRICTION_COUPLING, GHOST_MIN_SEPARATION, GHOST_RAM_DEPTH, GHOST_RAM_UP_DOT, GHOST_SPEC_UP_DOT, SURFACE_GATE_COS, syncFacet, syncFacetBlock, writeFacetAxes } from './conveyorContacts'
import type { FacetAxes } from './conveyorContacts'
import type { JoltModule } from './worldTypes'

/** What {@link ConveyorFacets.syncPart} reads of a behavior record, and the lookup it keeps on it. */
export interface FacetOwner {
  entry?: ConveyorEntry
  conveyorEntries?: ConveyorEntry[]
  copyDecks?: { entries: ConveyorEntry[] }[]
  facetSlots?: { rev: number; entries: ConveyorEntry[]; slots: number[] }
}

export class ConveyorFacets {
  // body id -> surface-velocity entries. A single-shape conveyor body maps to a
  // one-element array; a compound conveyor body maps to one entry per sub-shape,
  // indexed by the sub-shape's 1-based user data.
  private readonly conveyors = new Map<number, ConveyorEntry[]>()
  // body id -> body-local facet axes per entry, parallel to `conveyors` (null = the facet declares
  // none, and is then neither surface-gated nor flank-protected). Static, so written once at
  // registration rather than re-synced per step; see SURFACE_GATE_COS / FLANK_PROTECT_COS.
  private readonly conveyorAxes = new Map<number, (FacetAxes | null)[]>()
  private readonly listener: Jolt.ContactListenerJS
  /** forked build's native conveyor listener (null = stock build / ?jsconveyor / ?joltraw) */
  private readonly nativeConveyor: Jolt.ConveyorContactListener | null
  /** Float64 view over the native listener's facet table (see FACET_* constants) */
  private facetTable: Float64Array | null = null
  /** free slot blocks in the facet table (first-fit, coalesced on free) */
  private facetFree: { base: number; count: number }[] = []
  /** bodyKey → allocated facet block, for freeing when the conveyor body is destroyed */
  private readonly facetBlocks = new Map<number, { base: number; count: number }>()

  /**
   * Installs the contact listener on `system`. `surfaceVel` / `angularVel` are the JS listener's reusable Jolt
   * temporaries, made by the caller at a fixed point in its construction (so the world's Jolt allocations keep
   * their order); this table owns them from here and destroys them in dispose().
   * benchRaw: no listener at all; forceJsListener: the JS listener even where the native one exists.
   */
  constructor(
    private readonly J: JoltModule,
    system: Jolt.PhysicsSystem,
    private readonly surfaceVel: Jolt.Vec3,
    private readonly angularVel: Jolt.Vec3,
    opts: { benchRaw: boolean; forceJsListener: boolean },
  ) {
    this.listener = createConveyorContactListener(J, this.conveyors, this.conveyorAxes, surfaceVel, angularVel)
    // Prefer the forked build's native conveyor listener: the JS listener's per-contact WASM→JS
    // crossings dominate step cost at industrial contact counts (~12 ms/step @1000 boxes) and are
    // fundamentally incompatible with the multithreaded build (contact callbacks fire on pthread
    // job threads, whose isolated JS realms don't hold the JS listener object). The native class
    // runs the identical ghost-gate + surface-velocity math in C++, fed by a facet table that JS
    // re-syncs each step (see sync). Contract details: JoltJS.h in the fork.
    const NativeListener = (J as { ConveyorContactListener?: new (cap: number, a: number, b: number, c: number, d: number) => Jolt.ConveyorContactListener }).ConveyorContactListener
    this.nativeConveyor = !opts.benchRaw && !opts.forceJsListener && typeof NativeListener === 'function'
      ? new NativeListener(FACET_CAPACITY, GHOST_MIN_SEPARATION, GHOST_SPEC_UP_DOT, GHOST_RAM_DEPTH, GHOST_RAM_UP_DOT)
      : null
    if (this.nativeConveyor) {
      this.nativeConveyor.SetFrictionCoupling(FRICTION_COUPLING)
      // older forks lack these setters; they then convey every contact and gate every flank
      this.nativeConveyor.SetSurfaceGateCos?.(SURFACE_GATE_COS)
      this.nativeConveyor.SetFlankProtectCos?.(FLANK_PROTECT_COS)
      const heap = (J as unknown as { HEAPF64: Float64Array }).HEAPF64
      this.facetTable = new Float64Array(heap.buffer, this.nativeConveyor.GetFacetTablePtr(), FACET_CAPACITY * FACET_STRIDE)
      this.facetFree = [{ base: 0, count: FACET_CAPACITY }]
      system.SetContactListener(this.nativeConveyor)
    } else if (!opts.benchRaw) {
      system.SetContactListener(this.listener)
    }
  }

  /**
   * Register a conveyor body's surface-velocity entries with both listener paths: the JS map
   * (ContactListenerJS fallback + the per-step sync source) and, in native-listener mode, a facet
   * block advertised through the body's user data (tag bit 31, base slot bits 12..30, count bits
   * 0..11 - the contract in the fork's JoltJS.h). An empty entry list still gets the tag: the body
   * participates in ghost gating only (a conveying rig's frame rail). `key` is the body's bodyKey.
   */
  register(body: Jolt.Body, key: number, entries: ConveyorEntry[], axes?: readonly (FacetAxes | null)[]): void {
    this.rev++
    this.conveyors.set(key, entries)
    if (axes) this.conveyorAxes.set(key, [...axes])
    if (!this.nativeConveyor) return
    let base = 0
    let count = entries.length
    if (count > 0) {
      const block = allocFacets(this.facetFree, count)
      if (block === null) {
        // table exhausted (4096 facets ≈ hundreds of conveyors): degrade this body to gates-only
        // rather than failing the build; carry loss is visible, so log loudly
        console.error('[sim] conveyor facet table full - body registered for ghost gates only')
        count = 0
      } else {
        base = block
        this.facetBlocks.set(key, { base, count })
        syncFacetBlock(this.facetTable, entries, base)
        writeFacetAxes(this.facetTable, entries.length, axes, base)
      }
    }
    // arithmetic (not |) keeps the value a plain positive double; bits survive the u32 conversion
    body.SetUserData(CONVEYOR_TAG + base * 4096 + count)
  }

  /** forget a conveyor body that is being destroyed, and hand its facet block back */
  release(key: number): void {
    this.rev++
    this.conveyors.delete(key)
    this.conveyorAxes.delete(key)
    const block = this.facetBlocks.get(key)
    if (block) {
      freeFacets(this.facetFree, block.base, block.count)
      this.facetBlocks.delete(key)
    }
  }

  /**
   * Push every conveyor's current entry values into the native facet table, once per step after
   * behaviors ran (SDK belts recompute their `tan` facets' vx/vy/vz each tick; PLC speed changes
   * mutate entries live). O(total facets) double writes (hundreds), vs the tens of thousands of
   * per-contact JS crossings this replaces. Must complete before Jolt's Step, which reads the
   * table (on job threads in the multithreaded build).
   */
  sync(): void {
    if (!this.nativeConveyor) return
    for (const [key, arr] of this.conveyors) {
      if (arr.length === 0) continue
      const block = this.facetBlocks.get(key)
      if (block) syncFacetBlock(this.facetTable, arr, block.base)
    }
  }

  /** moves when a body is registered or released: a part's kept slots (syncPart) are looked up again */
  private rev = 0

  /**
   * Push one part's entries into the native facet table. SimWorld calls it for the parts whose scripts ran this
   * step: only they can have driven an entry (deckDrive.ts), and a line's surfaces are mostly at a steady speed.
   * Writing all 2,700 of a large line's every step took longer than its physics. Where the part's entries are in
   * the table is looked up once and kept on `b.facetSlots` until a body is registered or released.
   */
  syncPart(b: FacetOwner): void {
    const t = this.facetTable
    if (!this.nativeConveyor || !t) return
    let at = b.facetSlots
    if (!at || at.rev !== this.rev) {
      // every slot that holds one of the part's entries: an entry can stand in more than one registered body
      at = b.facetSlots = { rev: this.rev, entries: [], slots: [] }
      const own = new Set<ConveyorEntry>(b.conveyorEntries)
      if (b.entry) own.add(b.entry)
      if (b.copyDecks) for (const cd of b.copyDecks) for (const e of cd.entries) own.add(e)
      if (own.size > 0) {
        for (const [key, arr] of this.conveyors) {
          const block = this.facetBlocks.get(key)
          if (!block) continue
          for (let i = 0; i < arr.length; i++) {
            const e = arr[i]
            if (e && own.has(e)) {
              at.entries.push(e)
              at.slots.push(block.base + i)
            }
          }
        }
      }
    }
    const { entries, slots } = at
    for (let i = 0; i < entries.length; i++) syncFacet(t, entries[i]!, slots[i]!)
  }

  /** drop every registration (the world's bodies are going) */
  clear(): void {
    this.rev++
    this.conveyors.clear()
  }

  /** destroy the listeners and the temporaries; after the world's JoltInterface is gone */
  dispose(): void {
    const J = this.J
    J.destroy(this.listener)
    if (this.nativeConveyor) {
      J.destroy(this.nativeConveyor)
      this.facetTable = null
    }
    J.destroy(this.surfaceVel)
    J.destroy(this.angularVel)
  }
}
