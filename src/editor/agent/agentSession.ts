// What a connected agent is doing and has done to the open document, for the person watching (docs/agent-tools.md,
// "Working beside a person"). Two things: the call in flight, so the editor can say an agent is at work, and a review
// of the agent's run of edits. The review opens at the agent's first edit after the person last answered one, with the
// document as it stood before it, so the editor can list what changed and offer Keep or Revert.
//
// Revert walks the undo history back to where the run began, through the same path the History dock's jump uses. It
// does that only while every step above that point is the agent's: a person's edit made in between would go with it.
// A test the agent kept is project structure, not an undo step, so revert does not take it back; the review says so.
//
// Loaded with the tools (desktopAgent.ts), never on the first frame. The diff the review shows is agentReview.ts.

import type { Controller } from '../../core/controller'
import type { PartPackage } from '../../core/parts/partPackage'
import type { TestSpec } from '../../core/project/projectTest'
import type { SceneJSON } from '../../core/types'
import type { EditEvent } from '../store/storeHistory'
import type { EditorStore } from '../store/store'
import { AGENT_LABEL } from './toolKit'

const AGENT_PREFIX = `${AGENT_LABEL}:`

/** The document as it stood before the agent's run of edits. */
export interface AgentBaseline {
  startedAt: number
  /** the History position before the agent's first edit */
  depth: number
  /** the step under that position (label and time), so a history replaced since (another project) is recognised */
  anchor: { label: string; time: number } | null
  scene: SceneJSON
  program: { source: string; scanMs: number; controller: Controller | null }
  packages: readonly PartPackage[]
  tests: readonly TestSpec[]
}

export interface AgentActivity {
  /** the tool running now, or null */
  busy: string | null
  /** the most recent finished call */
  last: { tool: string; ok: boolean; at: number } | null
  /** calls since the editor opened */
  calls: number
  baseline: AgentBaseline | null
  /** how the person last answered a review, so the agent can be told its work was taken back */
  answer: { kind: 'kept' | 'reverted'; steps: number; at: number } | null
}

/** The store as the session reads it. */
export type AgentSessionStore = Pick<EditorStore, 'getState' | 'getEditHistory' | 'jumpToHistory' | 'documentScene' | 'snapshotProject'>

const sameAnchor = (a: AgentBaseline['anchor'], e: EditEvent | undefined): boolean =>
  a === null ? e === undefined : e !== undefined && e.label === a.label && e.time === a.time

export class AgentSession {
  private activity: AgentActivity = { busy: null, last: null, calls: 0, baseline: null, answer: null }
  private readonly listeners = new Set<() => void>()
  // the document before the call in flight: adopted as the baseline when that call turns out to be an edit
  private before: AgentBaseline | null = null

  constructor(private readonly store: AgentSessionStore) {}

  /** for useSyncExternalStore: the same object until something changes */
  getSnapshot = (): AgentActivity => this.activity

  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  private set(next: Partial<AgentActivity>): void {
    this.activity = { ...this.activity, ...next }
    for (const cb of this.listeners) cb()
  }

  /** A call is starting. Records the document so the call's edit, if it makes one, can be reviewed against it. */
  beginCall(tool: string): void {
    this.before = this.activity.baseline ? null : this.capture()
    this.set({ busy: tool })
  }

  /** A call finished. A call that left a new agent step on the history opens a review, unless one is open. */
  endCall(tool: string, ok: boolean): void {
    let baseline = this.activity.baseline
    const before = this.before
    this.before = null
    if (!baseline && before) {
      const h = this.store.getEditHistory()
      if (h.cursor > before.depth && h.events[h.cursor - 1]?.label.startsWith(AGENT_PREFIX)) baseline = before
    }
    this.set({ busy: null, last: { tool, ok, at: Date.now() }, calls: this.activity.calls + 1, baseline })
  }

  /**
   * The agent's run of steps since the review opened, oldest first. Empty once they are all undone or the history was
   * replaced (another project, a room), and the review then lapses: there is nothing left to answer.
   */
  pending(): EditEvent[] {
    const b = this.activity.baseline
    if (!b) return []
    const h = this.store.getEditHistory()
    if (h.cursor <= b.depth || !sameAnchor(b.anchor, h.events[b.depth - 1])) return []
    return h.events.slice(b.depth, h.cursor)
  }

  /** the person's own steps among pending(): while there are any, Revert would take them too, so it is not offered */
  userStepsInRun(): EditEvent[] {
    return this.pending().filter((e) => !e.label.startsWith(AGENT_PREFIX))
  }

  /** Why Revert is not offered now, or null when it is. */
  revertBlocker(): string | null {
    if (this.store.getState().collab) return 'In a shared project each person undoes their own edits.'
    if (this.store.getState().readOnly) return 'This editor is view-only.'
    const mine = this.userStepsInRun().length
    if (mine > 0) return `You made ${mine === 1 ? 'an edit' : `${mine} edits`} after the agent started. Use the History panel to choose what to undo.`
    return null
  }

  /** Keep the agent's edits: close the review. They stay in the history as ordinary steps. */
  keep(): void {
    if (this.activity.baseline) this.set({ baseline: null, answer: { kind: 'kept', steps: this.pending().length, at: Date.now() } })
  }

  /** Undo the agent's whole run. Returns false (and changes nothing) when revertBlocker() says why not. */
  revert(): boolean {
    const b = this.activity.baseline
    if (!b || this.revertBlocker() !== null) return false
    const steps = this.pending().length
    if (steps > 0) this.store.jumpToHistory(b.depth)
    this.set({ baseline: null, answer: { kind: 'reverted', steps, at: Date.now() } })
    return true
  }

  private capture(): AgentBaseline | null {
    const s = this.store.getState()
    // a room's history is shared and a view-only editor takes no edits: neither has a run to review
    if (s.collab || s.readOnly) return null
    const h = this.store.getEditHistory()
    const under = h.events[h.cursor - 1]
    return {
      startedAt: Date.now(),
      depth: h.cursor,
      anchor: under ? { label: under.label, time: under.time } : null,
      scene: this.store.documentScene(),
      program: { source: s.stProgram, scanMs: s.stScanMs, controller: s.controller },
      packages: s.userPackages,
      tests: this.store.snapshotProject().tests ?? [],
    }
  }
}
