// Whose run this client draws (docs/live-share.md "Watching"). Anyone running can be watched; this decides who, from
// what the person chose and what the room says:
//   - running one's own copy draws nothing else
//   - someone picked (an avatar's or the people list's Watch, or the chip) is followed until they are unpicked
//   - the owner's spotlight is followed by everyone else, until they dismiss it; a new spotlight asks again
//   - a view link, which exists to watch, follows the owner while the owner is here, waiting between their runs, so a
//     display never jumps to someone else's test run; with no owner here, it follows the only run going
// An editor otherwise follows nobody: a run taking over the view of someone editing would be an interruption.

import type { Runner } from '../../collab/session'

export interface FollowInputs {
  /** this client's presence id */
  self: number | null
  /** this client runs its own copy */
  running: boolean
  /** a view link */
  readOnly: boolean
  /** whom this client chose to watch, or null */
  picked: number | null
  /** the owner's presence id, as the server vouches for it */
  owner: number | null
  /** the owner asks everyone to watch */
  spotlight: boolean
  /** this client said no to the current spotlight */
  dismissed: boolean
  /** the others running now */
  runners: readonly Runner[]
}

export interface FollowTarget {
  /** whose run */
  who: number
  /** their run's stream, or null while they are not running (the chip says it is waiting for them) */
  stream: string | null
  why: 'picked' | 'spotlight' | 'view'
}

export function followTarget(i: FollowInputs): FollowTarget | null {
  if (i.running) return null
  const of = (who: number, why: FollowTarget['why']): FollowTarget | null =>
    who === i.self ? null : { who, stream: i.runners.find((r) => r.id === who)?.stream ?? null, why }
  if (i.picked !== null) return of(i.picked, 'picked')
  if (i.spotlight && i.owner !== null && !i.dismissed) return of(i.owner, 'spotlight')
  if (!i.readOnly) return null
  if (i.owner !== null) return of(i.owner, 'view')
  return i.runners.length === 1 ? of(i.runners[0]!.id, 'view') : null
}
