// Who hears a store change: React (which skips the transient stream) and the view/controller (which hears every
// change). Owned by the store (EditorStore.subscribers); setState, the single write path, is what notifies.

export class StoreSubscribers {
  /** React's subscribers (EditorStore.subscribe) */
  readonly listeners = new Set<() => void>()
  // view/controller subscribers, notified on every change including the high-frequency
  // transient drag/motion updates that `listeners` (React) skips
  private readonly viewListeners = new Set<(transient: boolean) => void>()

  subscribe(cb: () => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  /** `transient` tells the listener a drag's own move from a lasting change (a commit, a load, a peer's edit) */
  subscribeView(cb: (transient: boolean) => void): () => void {
    this.viewListeners.add(cb)
    return () => this.viewListeners.delete(cb)
  }

  /** a state change happened: the view always hears it, React unless it is `transient` */
  notify(transient: boolean): void {
    // the view always tracks the live scene (smooth gizmo drag); React skips the
    // transient stream and re-renders only on structural changes / commits
    for (const cb of this.viewListeners) cb(transient)
    if (!transient) for (const cb of this.listeners) cb()
  }
}
