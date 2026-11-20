// The store's "bring this on screen" requests: a dock panel, a place in the ST code, the PLC organizer's tasks. Each is a
// request, not a mutation: the layout lives in App state and the CodeMirror / organizer instances in whichever panel is
// mounted, so a caller outside them can only ask. Owned by the store (EditorStore.reveals), which delegates its public
// onReveal* / reveal* methods here; nothing in it reads or writes store state.
import type { DockPanelId } from '../dockLayout'

/** how long a code reveal made while no ST editor is mounted waits for one to mount (see revealStOffset) */
const ST_REVEAL_HOLD_MS = 3000

export class RevealRequests {
  // "Bring this dock panel on screen" - for code outside the dock UI that needs a panel visible
  // (the tutorial, whose card tells the user to watch the program appear in the PLC panel). The
  // layout itself lives in App state, so this is a request, not a mutation.
  private revealPanelListeners = new Set<(panel: DockPanelId) => void>()
  // Requests made before App subscribes: the store exists (main.tsx) before App mounts, and a request in that gap
  // would otherwise be dropped. They are kept until the first subscriber, with no time limit, since that gap is the
  // app's own boot.
  private pendingPanelReveals: DockPanelId[] = []

  /** subscribe to panel-reveal requests (App applies them to the dock layout) */
  onRevealPanel(cb: (panel: DockPanelId) => void): () => void {
    this.revealPanelListeners.add(cb)
    const pending = this.pendingPanelReveals
    this.pendingPanelReveals = []
    for (const panel of pending) cb(panel)
    return () => this.revealPanelListeners.delete(cb)
  }

  /** ask the app to surface a dock panel: front tab of its slot, dock un-collapsed */
  revealPanel(panel: DockPanelId): void {
    if (this.revealPanelListeners.size === 0) {
      if (!this.pendingPanelReveals.includes(panel)) this.pendingPanelReveals.push(panel)
      return
    }
    for (const cb of this.revealPanelListeners) cb(panel)
  }

  // "Put the ST cursor here" - the same shape as revealPanel, and for the same reason: the
  // CodeMirror instance is owned by whichever StEditor is mounted (docked, floating or popped out
  // into its own window), so a caller outside that panel can only ask. The Problems panel uses it to
  // jump to a compile error. It pairs with revealPanel('st'), because a docked PLC panel behind
  // another tab is unmounted and would drop the request (verify-tutorial-docked-plc pins this).
  private revealStOffsetListeners = new Set<(offset: number) => void>()
  // A request made while no ST editor is mounted. The revealPanel('st') it pairs with mounts a background tab on the
  // next render, after the request has already been made, so the request waits for that panel to subscribe. It waits
  // only briefly: a panel opened much later should not jump to a place nobody is still asking about.
  private pendingStReveal: { offset: number; at: number } | null = null

  /** subscribe to ST cursor-reveal requests (the mounted ST editor applies them) */
  onRevealStOffset(cb: (offset: number) => void): () => void {
    this.revealStOffsetListeners.add(cb)
    const pending = this.pendingStReveal
    this.pendingStReveal = null
    if (pending && Date.now() - pending.at <= ST_REVEAL_HOLD_MS) cb(pending.offset)
    return () => this.revealStOffsetListeners.delete(cb)
  }

  /** ask the ST editor to put the cursor at `offset` and scroll it into view */
  revealStOffset(offset: number): void {
    if (this.revealStOffsetListeners.size === 0) {
      this.pendingStReveal = { offset, at: Date.now() }
      return
    }
    this.pendingStReveal = null
    for (const cb of this.revealStOffsetListeners) cb(offset)
  }

  // "Type into the code": a click on the PLC panel's dock tab puts the keyboard in the text, so the click that brings the
  // panel up is also the one that starts typing. A background tab mounts its panel on the next render, so the request
  // waits briefly for it, like revealStOffset.
  private focusStListeners = new Set<() => void>()
  private pendingStFocus: number | null = null

  /** subscribe to "type into the code" requests (the mounted ST editor serves them while it shows text) */
  onFocusStCode(cb: () => void): () => void {
    this.focusStListeners.add(cb)
    const at = this.pendingStFocus
    this.pendingStFocus = null
    if (at !== null && Date.now() - at <= ST_REVEAL_HOLD_MS) cb()
    return () => this.focusStListeners.delete(cb)
  }

  /** ask the ST editor to take the keyboard */
  focusStCode(): void {
    if (this.focusStListeners.size === 0) {
      this.pendingStFocus = Date.now()
      return
    }
    this.pendingStFocus = null
    for (const cb of this.focusStListeners) cb()
  }

  // "Show the tasks": the PLC panel's organizer brings its Tasks section into view, unfolded. The same shape as
  // revealStOffset and for the same reason - a controller table's problem (Problems) has no line in the text, and the
  // panel it pairs with (revealPanel('st')) may only mount on the next render, so the request waits briefly for it.
  private revealStOrganizerListeners = new Set<() => void>()
  private pendingOrganizerReveal: number | null = null

  /** subscribe to "show the tasks" requests (the mounted PLC panel's organizer serves them) */
  onRevealStOrganizer(cb: () => void): () => void {
    this.revealStOrganizerListeners.add(cb)
    const at = this.pendingOrganizerReveal
    this.pendingOrganizerReveal = null
    if (at !== null && Date.now() - at <= ST_REVEAL_HOLD_MS) cb()
    return () => this.revealStOrganizerListeners.delete(cb)
  }

  /** ask the PLC panel's organizer to show the controller's tasks */
  revealStOrganizer(): void {
    if (this.revealStOrganizerListeners.size === 0) {
      this.pendingOrganizerReveal = Date.now()
      return
    }
    this.pendingOrganizerReveal = null
    for (const cb of this.revealStOrganizerListeners) cb()
  }

  // "Keep the selected row on screen" after Move Up / Move Down. The tree scrolls by itself only when the
  // selection changes, and a move keeps the same selection while the row walks out of view. A plain
  // index-change trigger would also fire when a group above it is expanded or collapsed, and pull the
  // tree back to the selection the user had scrolled away from. No pending request: an unmounted tree
  // has nothing to scroll.
  private revealTreeListeners = new Set<() => void>()

  /** subscribe to "keep the selected row on screen" requests (the mounted scene tree serves them) */
  onRevealTreeSelection(cb: () => void): () => void {
    this.revealTreeListeners.add(cb)
    return () => this.revealTreeListeners.delete(cb)
  }

  /** ask the scene tree to bring the selected row on screen */
  revealTreeSelection(): void {
    for (const cb of this.revealTreeListeners) cb()
  }
}
