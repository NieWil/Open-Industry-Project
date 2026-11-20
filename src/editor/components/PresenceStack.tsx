// Who is here, in a shared project: a small avatar per person in their presence colour, with the first letter of their
// name, anyone running ringed. A connection that fails for longer than a blip says so, naming the server, since a
// "Connecting…" that never ends tells nobody what is wrong. A click lists everyone by name with what they are doing: Watch beside anyone running,
// and for the owner, Spotlight on their own row (docs/live-share.md). It is also where this client sets the name the
// others see, a view-link visitor included (they have no Share popover).

import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { ReactElement } from 'react'
import { getCollabSnapshot, getDisplayName, getLocalIdentity, getPeers, retryConnection, setDisplayName, subscribeCollab, subscribePeers } from '../../collab/session'
import { collabUrl } from '../../collab/collabServer'
import type { EditorState, EditorStore } from '../store/store'
import { setSpotlight } from '../project/sharedProject'
import { useDismiss } from './popover'
import { defineMessages, t } from '../../core/i18n'

const M = defineMessages('presence', {
  here: { one: '{count} person here', other: '{count} people here' },
  connecting: 'Connecting…',
  offline: 'Offline',
  offlineTitle: "Can't reach the server for this shared project ({host}). Your changes are kept here and sync when it's back.",
  retry: 'Retry',
  you: '{name} (you)',
  running: 'running',
  watchingWho: 'watching {name}',
  watch: 'Watch',
  watchTitle: "Watch {name}'s run as it happens",
  watchingNow: 'Watching',
  spotlightMe: 'Spotlight me',
  spotlightMeTitle: 'Ask everyone here to watch your run. They can stop watching at any time.',
  stopSpotlight: 'Stop spotlight',
  yourName: 'Your name',
  namePlaceholder: 'shown to the others',
})

/** the most avatars drawn; the rest are a count */
const SHOWN = 3
/** a reconnect within this long is a blip (a server restart, a moment of Wi-Fi) and only shows "Connecting…" */
const OFFLINE_AFTER_MS = 10_000

/** the server's host, as a person would recognise it */
function serverHost(): string {
  try {
    return new URL(collabUrl()).host
  } catch {
    return collabUrl()
  }
}

interface Person {
  key: string
  id: number | null
  name: string
  color: string
  me: boolean
  running: boolean
  /** whose run they draw */
  watching: number | null
}

const initial = (name: string): string => (name.trim()[0] ?? '?').toUpperCase()

export function PresenceStack({ store, state, open, setOpen }: { store: EditorStore; state: EditorState; open: boolean; setOpen: (open: boolean | ((was: boolean) => boolean)) => void }): ReactElement | null {
  const collab = useSyncExternalStore(subscribeCollab, getCollabSnapshot)
  const peers = useSyncExternalStore(subscribePeers, getPeers)
  const [, setRenamed] = useState(0) // a new name of one's own redraws one's avatar
  const wrapRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  useDismiss(wrapRef, () => setOpen(false), { active: open, trigger: buttonRef })
  // redraw when a failing connection stops being a blip
  const [, setTick] = useState(0)
  useEffect(() => {
    if (collab.offlineSince === null) return
    const left = collab.offlineSince + OFFLINE_AFTER_MS - Date.now()
    if (left <= 0) return
    const timer = setTimeout(() => setTick((n) => n + 1), left)
    return () => clearTimeout(timer)
  }, [collab.offlineSince])
  if (!collab.room) return null

  const me = getLocalIdentity()
  const people: Person[] = [
    { key: 'me', id: collab.selfId, name: me.name, color: me.color, me: true, running: state.running, watching: state.liveTarget?.who ?? null },
    ...peers.map((p) => ({ key: String(p.clientId), id: p.clientId, name: p.name, color: p.color, me: false, running: p.running && p.stream !== null, watching: p.watching })),
  ]
  const nameOf = (id: number): string => people.find((p) => p.id === id)?.name ?? '?'
  const shown = people.slice(0, SHOWN)
  const more = people.length - shown.length
  const connected = collab.status === 'connected'
  const offline = !connected && collab.offlineSince !== null && Date.now() - collab.offlineSince >= OFFLINE_AFTER_MS
  const summary = connected ? t(M.here, { count: people.length }) : offline ? t(M.offlineTitle, { host: serverHost() }) : t(M.connecting)
  const owner = collab.owner !== null && collab.owner === collab.selfId
  const doing = (p: Person): string | null => (p.running ? t(M.running) : p.watching !== null ? t(M.watchingWho, { name: nameOf(p.watching) }) : null)

  return (
    <div className={`collab-status presence ${collab.status}`} ref={wrapRef}>
      <button
        ref={buttonRef}
        className="people-stack"
        title={summary}
        aria-label={summary}
        aria-haspopup="dialog"
        aria-expanded={open}
        data-testid="presence"
        onClick={() => setOpen((v) => !v)}
      >
        {!connected && <span className="collab-dot" aria-hidden="true" />}
        {offline && (
          <span className="people-offline" data-testid="presence-offline">
            {t(M.offline)}
          </span>
        )}
        {shown.map((p) => (
          <span key={p.key} className={`people-avatar${p.running ? ' live' : ''}`} style={{ background: p.color }} aria-hidden="true">
            {initial(p.name)}
          </span>
        ))}
        {more > 0 && <span className="people-more">+{more}</span>}
      </button>
      {open && (
        <div className="people-popover" role="dialog" aria-label={summary}>
          {offline ? (
            <div className="people-offline-note" role="status">
              <span>{summary}</span>
              <button className="people-action" data-testid="presence-retry" onClick={() => retryConnection()}>
                {t(M.retry)}
              </button>
            </div>
          ) : (
            <div className="share-popover-head">{summary}</div>
          )}
          <ul className="people-list" data-testid="people-list">
            {people.map((p) => {
              const watchingThem = state.liveTarget?.who === p.id
              return (
                <li key={p.key} className="people-row" data-testid={p.me ? 'people-me' : 'people-row'}>
                  <span className={`people-avatar${p.running ? ' live' : ''}`} style={{ background: p.color }} aria-hidden="true">
                    {initial(p.name)}
                  </span>
                  <span className="people-name">{p.me ? t(M.you, { name: p.name }) : p.name}</span>
                  {doing(p) && <span className={`people-doing${p.running ? ' live' : ' watching'}`}>{doing(p)}</span>}
                  {!p.me && p.running && p.id !== null && (
                    <button
                      className={`people-action${watchingThem ? ' on' : ''}`}
                      data-testid="people-watch"
                      title={t(M.watchTitle, { name: p.name })}
                      disabled={watchingThem || state.running}
                      onClick={() => {
                        store.setState({ liveWatch: p.id })
                        setOpen(false)
                      }}
                    >
                      {t(watchingThem ? M.watchingNow : M.watch)}
                    </button>
                  )}
                  {p.me && owner && collab.peers > 1 && (
                    <button
                      className={`people-action${collab.spotlight ? ' on' : ''}`}
                      data-testid="people-spotlight"
                      title={t(M.spotlightMeTitle)}
                      onClick={() => setSpotlight(!collab.spotlight)}
                    >
                      {t(collab.spotlight ? M.stopSpotlight : M.spotlightMe)}
                    </button>
                  )}
                </li>
              )
            })}
          </ul>
          <label className="share-name">
            <span className="share-name-label">{t(M.yourName)}</span>
            <input
              className="share-name-input"
              data-testid="people-name"
              type="text"
              maxLength={40}
              placeholder={t(M.namePlaceholder)}
              defaultValue={getDisplayName()}
              onChange={(e) => {
                setDisplayName(e.target.value)
                setRenamed((n) => n + 1)
              }}
              // typing a name must not drive the editor's shortcuts; Escape still closes the list
              onKeyDown={(e) => {
                if (e.key !== 'Escape') e.stopPropagation()
              }}
            />
          </label>
        </div>
      )}
    </div>
  )
}
