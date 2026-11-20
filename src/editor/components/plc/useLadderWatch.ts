// The running program's values under the ladder's operands (LadderView.tsx): the variable image polled while it runs,
// looked up by operand text (ladderWatch.ts), and the room each value is given so a changing number does not move
// the sheet.

import type { TagValue } from '../../../plc/types'
import { indexWatch, shownUnchanged, watchLookup, type WatchIndex, type WatchLookup } from './ladderWatch'
import { useEffect, useMemo, useRef, useState } from 'react'
import { hasKeySet, keySetOf } from '../../../core/watchKeys'
import { watchKeyCount } from '../../../core/watchTable'

/** the image while a running program has published none yet: one object, so each poll is the same state */
const NO_VALUES: Readonly<Record<string, TagValue>> = Object.freeze({})

export function useLadderWatch(
  live: boolean,
  getWatch: () => Readonly<Record<string, TagValue>> | null | undefined,
  source: string,
  writeLive: ((key: string, text: string) => string | null) | undefined,
  getForces: (() => Readonly<Record<string, number | boolean>>) | undefined,
  onForces: ((cb: () => void) => () => void) | undefined,
) {
  // the newest image the poll saw. Held in a ref: the sheet is redrawn when a value it SHOWS changed, not when an
  // image arrived, and any redraw (a tab opened, a selection moved) reads the newest one.
  const latest = useRef<Readonly<Record<string, TagValue>> | null>(null)
  const [, redraw] = useState(0)
  /** what the last draw read for each operand text it asked about */
  const shown = useRef(new Map<string, TagValue | undefined>())
  const sourceRef = useRef(source)
  sourceRef.current = source
  const getWatchRef = useRef(getWatch)
  getWatchRef.current = getWatch
  const getForcesRef = useRef(getForces)
  getForcesRef.current = getForces
  const onForcesRef = useRef(onForces)
  onForcesRef.current = onForces
  // the forced variables: a force is set in the Watch dock, the Inspector or here, so this listens for one being set or
  // released (the panel's subscription, the same every surface uses) rather than polling
  const [forces, setForces] = useState<Readonly<Record<string, number | boolean>>>({})
  useEffect(() => {
    if (!live) {
      setForces({})
      return
    }
    const read = (): void => setForces(getForcesRef.current?.() ?? {})
    read()
    return onForcesRef.current?.(read)
  }, [live])

  // the values under the operands: the running program's image (its key set is fixed, so its index is kept across polls:
  // ladderWatch.ts)
  const watchIndex = useRef<{ keys: number; set: object | null; src: string; index: WatchIndex } | null>(null)
  /** `image` as the rungs read it; `indexed` says whether the index it reads through had to be built for it */
  const lookupFor = (image: Readonly<Record<string, TagValue>>, src: string): { lookup: WatchLookup; indexed: boolean } => {
    // told apart by key set when the image has one (core/watchKeys.ts), else by its number of keys
    const set = hasKeySet(image) ? keySetOf(image) : null
    const keys = set === null ? watchKeyCount(image) : 0
    const held = watchIndex.current
    // A running program's key set is fixed, so the index is kept across polls. The poll hands a fresh object every
    // 120 ms, and indexing five thousand values on each would be the whole cost of a watch. A reload swaps the
    // program while it keeps running, so the source text is checked too: a tag renamed and reloaded keeps the same
    // key count, and a stale index would answer for names that no longer exist (it memoises the misses too), so
    // every rung would draw de-energized while the controller is scanning normally.
    const indexed = !held || held.set !== set || held.keys !== keys || held.src !== src
    if (indexed) watchIndex.current = { keys, set, src, index: indexWatch(image) }
    return { lookup: watchLookup(image, watchIndex.current!.index), indexed }
  }

  // The image changes every scan, independent of any store update, so it is polled (as the text view's is). The sim
  // client replaces the image when new values arrive, so an unchanged image is the same object. A new one redraws the
  // sheet only when a value the last draw read is different in it: the sheet draws a routine's every rung, and most
  // images change nothing it shows. Comparing is one lookup per operand drawn.
  useEffect(() => {
    if (!live) {
      latest.current = null
      redraw((n) => n + 1)
      return
    }
    const id = setInterval(() => {
      const next = getWatchRef.current() ?? NO_VALUES
      const was = latest.current
      if (next === was) return
      latest.current = next
      if (was === null) return redraw((n) => n + 1)
      const { lookup, indexed } = lookupFor(next, sourceRef.current)
      if (indexed || !shownUnchanged(shown.current, lookup)) redraw((n) => n + 1)
    }, 120)
    return () => clearInterval(id)
  }, [live])
  const image = live ? latest.current : null
  const read = useMemo(() => {
    if (!image) {
      watchIndex.current = null
      return watchLookup(null, null)
    }
    return lookupFor(image, source).lookup
  }, [image, source])
  // each draw starts its own record of what it read: the next image is compared against the newest draw
  const asked = new Map<string, TagValue | undefined>()
  shown.current = asked
  const keyOf = read.keyOf
  const valueOf = (text: string): TagValue | undefined => {
    const v = read.valueOf(text)
    asked.set(text, v)
    return v
  }
  /** Change the image the sheet shows (a toggled bit shown before the frame that confirms it), and redraw. */
  const setWatch = (update: (w: Readonly<Record<string, TagValue>> | null) => Readonly<Record<string, TagValue>> | null): void => {
    const next = update(latest.current)
    if (next === latest.current) return
    latest.current = next
    redraw((n) => n + 1)
  }
  /** values are drawn under the operands while the program runs */
  const showsValues = live
  // Room for each value, so a running program does not move the sheet. A box is sized from what is in it, and a live
  // value is in it: `99` becoming `100` widened the box, which pushed everything after it along the rung (and could
  // wrap a long rung onto another line), then `100` falling back to `99` pulled it all back - every few scans. So a
  // value's room only ever grows: a number starts with four digits of it (so the ordinary 2-3 digit counters never
  // move at all) and a value that outgrows that widens its box once, not every time it changes. Per slot, remembered
  // until the program starts or stops - the values change meaning then. (`ch` is exact here: boxes are monospace.)
  const valueRoom = useRef<{ live: boolean; room: Map<string, number> }>({ live, room: new Map() })
  if (valueRoom.current.live !== live) valueRoom.current = { live, room: new Map() }
  const roomFor = (slot: string, shown: string, numeric: boolean): number => {
    const want = Math.max(shown.length, numeric ? 4 : 0)
    const had = valueRoom.current.room.get(slot) ?? 0
    const room = Math.max(had, want)
    if (room !== had) valueRoom.current.room.set(slot, room)
    return room
  }
  /** where a value typed under an operand goes: into the running program */
  const writeValue = live ? writeLive : undefined
  /** is the operand a forced variable of the running program */
  const forcedOf = (text: string): boolean => heldAt(text) !== undefined
  /** the value a forced operand is held at, or undefined when it is not forced */
  const heldAt = (text: string): number | boolean | undefined => {
    const key = live ? keyOf(text) : null
    return key !== null && key !== undefined && key in forces ? forces[key] : undefined
  }
  return { setWatch, valueOf, keyOf, roomFor, showsValues, writeValue, forcedOf, heldAt }
}
