import { useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import { runCommand } from '../../commands'
import type { EditorController } from '../../controller'
import { statusLine, type ExternalPlcStatus } from '../../links/externalPlcStatus'
import type { EditorState } from '../../store/store'
import { defineMessages, t } from '../../../core/i18n'

const M = defineMessages('plcLinkStatus', {
  button: 'External PLC',
  plcs: { one: '{n} PLC', other: '{n} PLCs' },
})

// The external PLC link's state, beside Play and Stop: where a vendor tool shows that it is online, and where someone
// looks when the line does nothing. Drawn only while Play hands the scene to an external PLC, so a scene that runs its
// own program shows nothing here. With named controllers (`Cell2::...`, NamedPlcsSection.tsx) it stands for every
// link: the dot is the worst one's health, and the tooltip has a line per link. A click opens
// Controller Properties, which lists the points the link serves and why it failed. It sits where it is visible
// whatever tab is in front.

/** How the link is doing, as one word for the dot's colour. */
function health(s: ExternalPlcStatus, running: boolean): 'idle' | 'busy' | 'ok' | 'bad' {
  if (!running || s.state === 'off') return 'idle'
  if (s.state === 'failed' || s.stale) return 'bad'
  if (s.state === 'starting') return 'busy'
  // serving with no PLC connected yet is not a failure, and not a working link either
  return s.mode === 'serve' && s.masters.length === 0 ? 'busy' : 'ok'
}

const WORST: Record<ReturnType<typeof health>, number> = { idle: 0, ok: 1, busy: 2, bad: 3 }

export function PlcLinkStatus({ state, controller }: { state: EditorState; controller: EditorController }): ReactElement | null {
  const settings = state.externalPlc
  // the PLCs Play connects: a controller the simulator runs has no link to show
  const named = settings.controllers.filter((c) => c.enabled && c.runsOn === 'plc')
  const shown = (settings.enabled || named.length > 0) && controller.externalPlcAvailable
  /** every link's status: the default controller's first, when it runs on a PLC, then each named one by name */
  const readAll = (): { name: string | null; status: ExternalPlcStatus }[] => [
    ...(settings.enabled ? [{ name: null, status: { ...controller.externalPlcStatus } }] : []),
    ...named.map((c) => ({ name: c.name, status: { ...controller.namedPlcStatus(c.name) } })),
  ]
  const [statuses, setStatuses] = useState(readAll)

  // the links report connects and failures; request counts move every poll, so they are sampled while running
  useEffect(() => {
    if (!shown) return
    const read = (): void => setStatuses(readAll())
    read()
    const off = controller.onExternalPlcStatus(read)
    const timer = state.running ? window.setInterval(read, 500) : undefined
    return () => {
      off()
      if (timer !== undefined) window.clearInterval(timer)
    }
    // readAll reads the settings, which change only while stopped, and a change re-renders with a new `settings`
  }, [controller, state.running, shown, settings])

  if (!shown) return null
  const h = statuses.map((s) => health(s.status, state.running)).reduce((a, b) => (WORST[b] > WORST[a] ? b : a), 'idle' as ReturnType<typeof health>)
  const title = statuses
    .map((s) => {
      const link = s.name === null ? settings : settings.controllers.find((c) => c.name === s.name)
      const line = link ? statusLine(s.status, state.running, link, s.name !== null) : ''
      return s.name === null ? line : `${s.name}: ${line}`
    })
    .join('\n')
  // what is connected: the main external PLC alone keeps its name; one named controller is named; more are counted
  const count = statuses.length
  const label = count === 1 ? (settings.enabled ? t(M.button) : named[0]!.name) : t(M.plcs, { count, n: count })
  return (
    <div className="plc-link">
      <button
        type="button"
        className="plc-link-button"
        data-testid="plc-link-status"
        data-health={h}
        aria-haspopup="dialog"
        title={title}
        onClick={() => runCommand('sim.externalPlc')}
      >
        <span className={`plc-link-dot ${h}`} aria-hidden="true" />
        {label}
      </button>
    </div>
  )
}
