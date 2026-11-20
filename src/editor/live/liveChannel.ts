// Joins a room's live share (collab/liveShare.ts, set up in main.tsx's room boot) to the controller, which owns the
// run and the view. The room side sets `out` while this client runs in a room; the controller sets `in` while it is
// mounted. Either may be null: a solo session has no room, and frames before the viewport mounts are dropped.

import type { BoxFrame } from '../../core/frame'
import type { LiveWatchValue } from '../../core/live/liveFrameWire'

export interface LiveOut {
  /** a frame of this client's run, and its PLC variables (the watch table; null with no program attached) */
  push(frame: BoxFrame, watch: Readonly<Record<string, LiveWatchValue>> | null): void
}

export interface LiveIn {
  /** a frame of the run this client follows, and that client's PLC variables */
  frame(frame: BoxFrame, watch: Readonly<Record<string, LiveWatchValue>>): void
  /** stop drawing it: that run ended, or this client is starting one of its own */
  end(): void
}

export const liveChannel: { out: LiveOut | null; in: LiveIn | null } = { out: null, in: null }
