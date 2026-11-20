import { useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { createPortal } from 'react-dom'
import type { DeviceTags } from '../../../plc'
import type { DeviceForcing } from './OrganizerTree'
import { formatPlcValue } from '../../program/plcValueText'
import { trapTab, useModalKeys } from '../inspector/menu'
import { activeClipboard, dialogHost } from '../../dialogHost'
import { CloseIcon } from '../toolbarIcons'
import { defineMessages, t } from '../../../core/i18n'
import { tNodes } from '../../i18nNodes'

const M = defineMessages('deviceTags', {
  dialog: '{name} tags',
  close: 'Close',
  intro: 'The tags this device speaks. Click a name to copy it; type in the field to rewire it. {input} means the device writes the tag (the program reads it as a VAR_INPUT), {output} means the device reads it (a VAR_OUTPUT).',
  introInput: 'Input',
  introOutput: 'Output',
  field: 'Field',
  direction: 'Direction',
  tag: 'Tag',
  writesIt: 'the device writes it',
  readsIt: 'the device reads it',
  noDirection: 'direction not declared',
  input: 'INPUT',
  output: 'OUTPUT',
  tagName: 'tag name',
  copyTitle: 'Copy the tag name',
  copy: 'copy',
  commsTitle: 'Off, the device speaks none of these tags',
  comms: 'Enable Comms',
  copyAllTitle: 'Copy every wired tag name, one per line',
  copyAll: 'Copy all',
  force: 'Force',
  forceTitle: 'Hold {tag} at its value until released. The program reads it and the parts see it, whatever the program writes',
  release: 'Release',
  releaseTitle: 'Give {tag} back to the program from its next scan',
  forced: 'forced',
  forcedTitle: 'Held at {value} until released, whatever the program writes or the part feeds',
})

/**
 * One device's PLC tags - the fields its package declares, each with the tag name wired in, to copy
 * (a click on the name) and to edit in place (the same edit the Inspector's field makes). Opened from
 * the organizer's Devices tree by double-click (OrganizerTree.tsx), so a program can be written from the
 * device list without leaving the PLC panel.
 */
export function DeviceTagsDialog({
  device,
  readOnly,
  onSetTag,
  onSetComms,
  forcing,
  onClose,
}: {
  device: DeviceTags
  readOnly: boolean
  onSetTag: (key: string, value: string) => void
  onSetComms: (on: boolean) => void
  /** force a tag while the program runs; absent = no force column */
  forcing?: DeviceForcing
  onClose: () => void
}): ReactElement {
  const dialogRef = useRef<HTMLDivElement>(null)
  // opened where the user is: the popped-out PLC window, when that is what they double-clicked in
  const dialogHostOnce = useRef(dialogHost())
  const [copied, setCopied] = useState<string | null>(null)
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  // the forces, and whether a program runs: a force is set here, in the Watch dock or by the agent, and Play or Stop
  // happen while this is open, so both are re-read when they change
  const [forces, setForces] = useState(() => forcing?.forces() ?? {})
  const [, setStatusTick] = useState(0)
  useEffect(() => {
    if (!forcing) return
    const offForces = forcing.onForces(() => setForces(forcing.forces()))
    const offStatus = forcing.onProgramStatus(() => setStatusTick((n) => n + 1))
    return () => {
      offForces()
      offStatus()
    }
  }, [forcing])
  const [forceError, setForceError] = useState<string | null>(null)
  // the modal owns every key at the window (capture), so Enter on a field is committed from here, not the field
  useModalKeys(onClose, (e) => {
    // (tag name, not `instanceof`: in a popped-out window the input belongs to another realm)
    if (e.key === 'Enter' && (e.target as HTMLElement | null)?.tagName === 'INPUT' && (e.target as HTMLInputElement).dataset.key) {
      e.preventDefault()
      commit((e.target as HTMLInputElement).dataset.key!)
    } else if (dialogRef.current) trapTab(dialogRef.current, e)
  })
  const copy = (text: string): void => {
    if (!text) return
    void activeClipboard()?.writeText(text).then(
      () => {
        setCopied(text)
        window.setTimeout(() => setCopied((c) => (c === text ? null : c)), 1200)
      },
      () => {},
    )
  }
  const commit = (key: string): void => {
    const v = drafts[key]
    if (v === undefined) return
    setDrafts((d) => {
      const next = { ...d }
      delete next[key]
      return next
    })
    const field = device.fields.find((f) => f.key === key)
    if (field && v.trim() !== field.value) onSetTag(key, v.trim())
  }
  /** Force / Release for one field, while the program runs and has the variable it names; an empty cell otherwise */
  const forceCell = (fieldKey: string, tag: string): ReactElement => {
    // a device whose comms switch is off reads none of its tags; keyOf is null for a STRING, which cannot be forced
    const key = tag && device.enabled ? forcing!.keyOf(tag) : null
    if (key === null) return <span />
    const held = key in forces
    return (
      <span className="device-force-cell">
        {held && (
          <span className="device-forced-badge" data-testid={`device-forced-${fieldKey}`} title={t(M.forcedTitle, { value: formatPlcValue(forces[key]!) })}>
            {t(M.forced)}
          </span>
        )}
        <button
        className={`plc-mini-btn device-force${held ? ' on' : ''}`}
        data-testid={`device-force-${fieldKey}`}
        aria-pressed={held}
        title={t(held ? M.releaseTitle : M.forceTitle, { tag })}
        onClick={() => {
          if (held) forcing!.release(key)
          else setForceError(forcing!.force(key))
        }}
      >
        {t(held ? M.release : M.force)}
        </button>
      </span>
    )
  }
  return createPortal(
    <div className="author-backdrop" onPointerDown={onClose}>
      <div ref={dialogRef} className="author-dialog device-tags-dialog" role="dialog" aria-label={t(M.dialog, { name: device.name })} data-testid="device-tags-dialog" onPointerDown={(e) => e.stopPropagation()}>
        <div className="author-head">
          <h2>
            {device.name} <span className="plc-dim">· {device.kind}</span>
          </h2>
          <button className="author-close" title={t(M.close)} aria-label={t(M.close)} onClick={onClose}>
            <CloseIcon />
          </button>
        </div>
        <p className="author-intro">{tNodes(M.intro, { input: <b>{t(M.introInput)}</b>, output: <b>{t(M.introOutput)}</b> })}</p>
        <div className={`device-tags-grid${forcing ? ' with-force' : ''}`}>
          <span className="hdr">{t(M.field)}</span>
          <span className="hdr">{t(M.direction)}</span>
          <span className="hdr">{t(M.tag)}</span>
          <span className="hdr" />
          {forcing && <span className="hdr" />}
          {device.fields.map((f) => (
            <span key={f.key} style={{ display: 'contents' }}>
              <span title={f.label}>{f.label.replace(/\s*\(.*\)\s*$/, '')}</span>
              <span className={`dir ${f.section === 'VAR_INPUT' ? 'in' : f.section === 'VAR_OUTPUT' ? 'out' : ''}`} title={t(f.section === 'VAR_INPUT' ? M.writesIt : f.section === 'VAR_OUTPUT' ? M.readsIt : M.noDirection)}>
                {f.section === 'VAR_INPUT' ? t(M.input) : f.section === 'VAR_OUTPUT' ? t(M.output) : '?'}
                {f.type ? ` ${f.type}` : ''}
                {f.unit ? ` ${f.unit}` : ''}
              </span>
              <input
                data-testid={`device-tag-${f.key}`}
                data-key={f.key}
                value={drafts[f.key] ?? f.value}
                placeholder={t(M.tagName)}
                spellCheck={false}
                readOnly={readOnly}
                onChange={(e) => setDrafts((d) => ({ ...d, [f.key]: e.target.value }))}
                onBlur={() => commit(f.key)}
              />
              <button className="plc-mini-btn" data-testid={`device-copy-${f.key}`} disabled={!f.value} title={t(M.copyTitle)} onClick={() => copy(f.value)}>
                {copied === f.value && f.value ? '✓' : t(M.copy)}
              </button>
              {forcing && forceCell(f.key, f.value)}
            </span>
          ))}
        </div>
        {forceError && (
          <div className="ld-vars-error" role="alert" data-testid="device-force-error">
            ⚠ {forceError}
          </div>
        )}
        <div className="device-tags-foot">
          {device.switchable && (
            <label title={t(M.commsTitle)}>
              <input type="checkbox" data-testid="device-comms" checked={device.enabled} disabled={readOnly} onChange={(e) => onSetComms(e.target.checked)} /> {t(M.comms)}
            </label>
          )}
          <button onClick={() => copy(device.fields.filter((f) => f.value).map((f) => f.value).join('\n'))} disabled={!device.fields.some((f) => f.value)} title={t(M.copyAllTitle)}>
            {t(M.copyAll)}
          </button>
          <button onClick={onClose}>{t(M.close)}</button>
        </div>
      </div>
    </div>,
    dialogHostOnce.current,
  )
}
