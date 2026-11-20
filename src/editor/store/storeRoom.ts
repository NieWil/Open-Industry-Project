// The writers the collab bridge installs so a room keeps what the store changes: a committed part package, each
// committed edit's label for the room's feed, the scene's step rate. All null solo, where the store keeps those itself.
// Owned by the store (EditorStore.room); the program's own sink and transaction live with the program (storeProgram).
import type { PartPackage } from '../../core/parts/partPackage'
import type { SimRate } from '../../core/types'
import type { EditEventInput } from './storeHistory'

export class RoomSinks {
  // room mode: the collab bridge installs a sink that writes a (committed) custom-part package to the
  // shared doc. Custom-part packages (geometry + behavior script) live outside SceneJSON, so this is the
  // channel that propagates an authored part / behavior-script edit to peers. null in solo mode.
  private packageSink: ((pkg: PartPackage) => void) | null = null
  // ...and the one that takes a deleted part out of the room, or puts a built-in's back to the app's version while it
  // is still placed (`revertTo`)
  private packageRemover: ((id: string, revertTo: PartPackage | null) => void) | null = null
  // room mode: the collab bridge installs a sink that appends every committed edit's label to the room's
  // shared feed (the History dock's activity list). This is the only place commit labels cross into the
  // collab layer - the bridge's scene diffing never sees them. null in solo mode.
  private editEventSink: ((e: EditEventInput) => void) | null = null
  // Where a step-rate change goes to be kept: the room's `meta` in a room, null solo (then the store
  // folds it into the scene's slot of the project doc). Its own sink, not the program's, because the rate
  // belongs to the scene: a scene with no program still has one.
  private simHzSink: ((hz: SimRate) => void) | null = null

  setPackageSink(sink: ((pkg: PartPackage) => void) | null, remove?: (id: string, revertTo: PartPackage | null) => void): void {
    this.packageSink = sink
    this.packageRemover = sink ? (remove ?? null) : null
  }

  setEditEventSink(sink: ((e: EditEventInput) => void) | null): void {
    this.editEventSink = sink
  }

  setSimHzSink(sink: ((hz: SimRate) => void) | null): void {
    this.simHzSink = sink
  }

  /** a committed edit's line in the room's feed (nothing without a sink; `event` is only built when there is one) */
  feed(event: () => EditEventInput): void {
    this.editEventSink?.(event())
  }

  /** a committed package, out to the room (nothing without a sink) */
  sendPackage(pkg: PartPackage): void {
    this.packageSink?.(pkg)
  }

  /** a deleted part, out of the room (nothing without a sink) */
  removePackage(id: string, revertTo: PartPackage | null): void {
    this.packageRemover?.(id, revertTo)
  }

  /** Keep a step-rate change through the room's sink. False solo (no sink): the store keeps it itself. */
  keepSimHz(hz: SimRate): boolean {
    if (!this.simHzSink) return false
    this.simHzSink(hz)
    return true
  }
}
