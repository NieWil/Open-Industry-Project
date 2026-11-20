import { useMemo, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { deviceTags } from '../../../plc/bindings'
import { getCommand, runCommand } from '../../commands'
import type { EditorController } from '../../controller'
import { devicesWiredTo, usePlcForces } from '../../program/plcForces'
import type { EditorState } from '../../store/store'
import { formatPlcValue } from '../../program/plcValueText'
import { useDismiss } from '../popover'
import { defineMessages, t } from '../../../core/i18n'

const M = defineMessages('plcForces', {
  button: { one: '{count} forced', other: '{count} forced' },
  title: {
    one: '{count} variable is held at a forced value. Click to see it or release it',
    other: '{count} variables are held at forced values. Click to see them or release them',
  },
  titleStopped: {
    one: '{count} variable stays forced and is held from the first scan when you press Play. Click to see it or release it',
    other: '{count} variables stay forced and are held from the first scan when you press Play. Click to see them or release them',
  },
  popover: 'Forced variables',
  release: 'Release',
  releaseTitle: 'Give {name} back to the program from its next scan',
  wiredTo: 'wired to {parts}',
})

// The program's forced variables, beside Play and Stop, while there are any, running or stopped: a force left on is
// the commissioning mistake that costs the most time, since the line then runs on a value nobody is looking at, and a
// force stays through Stop into the next run. Forces are set in the Watch dock (WatchPanel.tsx); this is where they
// stay in view and where they all go at once.

export function ForcesStatus({ controller, state }: { controller: EditorController; state: EditorState }): ReactElement | null {
  const forces = usePlcForces(controller)
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useDismiss(ref, () => setOpen(false), { active: open })
  // the parts each forced variable reaches, so the list says where the line is being overridden
  const parts = state.scene.parts
  const devices = useMemo(() => (open ? deviceTags(parts) : []), [open, parts])
  const wiredTo = (key: string): string => [...new Set(devicesWiredTo(devices, key, key, controller.plcAliases).map((u) => u.device.name))].join(', ')

  const names = Object.keys(forces)
  if (names.length === 0) return null
  // what each forced variable reaches, worked out once a render (each one walks every device)
  const wired: Record<string, string> = open ? Object.fromEntries(names.map((n) => [n, wiredTo(n)])) : {}
  return (
    <div className="plc-link" ref={ref}>
      <button
        type="button"
        className={`plc-link-button plc-forces-button${open ? ' active' : ''}`}
        data-testid="plc-forces-status"
        aria-haspopup="dialog"
        aria-expanded={open}
        title={t(state.running ? M.title : M.titleStopped, { count: names.length })}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="plc-link-dot forced" aria-hidden="true" />
        {t(M.button, { count: names.length })}
      </button>
      {open && (
        <div className="plc-link-note" role="dialog" aria-label={t(M.popover)} data-testid="plc-forces-popover">
          <div className="plc-forces-list">
            {names.map((name) => (
              <div key={name} className="plc-forces-row" data-testid="plc-forces-row" data-name={name}>
                <span className="plc-forces-name">
                  {name}
                  {wired[name] && <span className="plc-forces-wired">{t(M.wiredTo, { parts: wired[name] })}</span>}
                </span>
                <span className="plc-forces-value">{formatPlcValue(forces[name]!, undefined, 40)}</span>
                <button type="button" className="ctl-btn" title={t(M.releaseTitle, { name })} onClick={() => controller.releasePlcForces(name)}>
                  {t(M.release)}
                </button>
              </div>
            ))}
          </div>
          <button
            type="button"
            className="ctl-btn"
            data-testid="plc-forces-release-all"
            onClick={() => {
              setOpen(false)
              runCommand('sim.releaseForces')
            }}
          >
            {getCommand('sim.releaseForces')?.label ?? ''}
          </button>
        </div>
      )}
    </div>
  )
}
