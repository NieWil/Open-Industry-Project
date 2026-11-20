// A product param's settings, under its dropdown in the Inspector (paramField.tsx loads this on demand): the chosen
// product's own params, stored on the part as one JSON object in the hidden settings param.
import type { ReactNode } from 'react'
import type { PartInstance } from '../../../core/types'
import type { PartPackage } from '../../../core/parts/partPackage'
import { labelHead, packageParamSpecs, switchValue, visibleWhenHolds } from '../../../core/packageParams'
import { titleCase } from './shared'
import type { Update } from './shared'

/**
 * A product param's settings ({@link TextParamSpec.settings}): the chosen product's own params, edited as fields under
 * the dropdown and stored on the part as one JSON object in the hidden settings param. Only what differs from the
 * product's default is kept, so an untouched field follows the product if its definition changes.
 */
export function ProductSettings({
  pkg,
  settingsKey,
  stored,
  disabled,
  update,
}: {
  pkg: PartPackage
  settingsKey: string
  stored: unknown
  disabled: boolean
  update: Update
}) {
  const values = parseProductSettings(stored)
  const specs = packageParamSpecs(pkg).filter((s) => !s.hidden && (s.kind === 'enum' || s.kind === 'number' || s.kind === 'boolean' || (s.kind === 'color' && !s.list) || (s.kind === 'text' && !s.product)))
  const all = packageParamSpecs(pkg)
  const set = (key: string, value: string | number | boolean, def: unknown): void =>
    update(`Edit ${pkg.name} setting`, settingsKey, (p) => {
      const next = { ...parseProductSettings((p.params as Record<string, unknown>)[settingsKey]) }
      if (value === def) delete next[key]
      else next[key] = value
      return { ...p, params: { ...p.params, [settingsKey]: Object.keys(next).length ? JSON.stringify(next) : '' } } as PartInstance
    })
  return (
    <>
      {specs
        .filter((s) => visibleWhenHolds(s.visibleWhen, s.visibleWhen ? switchValue(all, { ...values }, s.visibleWhen.param) : undefined))
        .map((s) => {
          const v = values[s.key] ?? s.default
          let control: ReactNode
          if (s.kind === 'enum') {
            control = (
              <select value={String(v)} disabled={disabled} onChange={(e) => set(s.key, e.target.value, s.default)}>
                {s.options.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            )
          } else if (s.kind === 'number') {
            control = (
              <input
                type="number"
                value={typeof v === 'number' ? v : Number(s.default)}
                min={s.min}
                max={s.max}
                step={s.step}
                disabled={disabled}
                onChange={(e) => {
                  const n = Number(e.target.value)
                  if (Number.isFinite(n)) set(s.key, Math.min(s.max, Math.max(s.min, n)), s.default)
                }}
              />
            )
          } else if (s.kind === 'boolean') {
            control = <input type="checkbox" checked={v === true} disabled={disabled} onChange={(e) => set(s.key, e.target.checked, s.default)} />
          } else if (s.kind === 'color') {
            control = <input type="color" value={typeof v === 'string' ? v.slice(0, 7) : '#ffffff'} disabled={disabled} onChange={(e) => set(s.key, e.target.value, s.default)} />
          } else {
            control = <input type="text" value={typeof v === 'string' ? v : ''} disabled={disabled} onChange={(e) => set(s.key, e.target.value, s.default)} />
          }
          return (
            <div key={s.key} className="prop-row prop-row-product-setting" data-param={`${settingsKey}.${s.key}`}>
              <label className="field">
                <span className="field-label" title={s.desc}>
                  {titleCase(labelHead(s.label))}
                </span>
                <span className="field-control">{control}</span>
              </label>
            </div>
          )
        })}
    </>
  )
}

/** a product settings param's JSON object, or {} for anything else (empty, malformed, not an object) */
function parseProductSettings(v: unknown): Record<string, string | number | boolean> {
  if (typeof v !== 'string' || v === '') return {}
  try {
    const o: unknown = JSON.parse(v)
    if (typeof o !== 'object' || o === null || Array.isArray(o)) return {}
    const out: Record<string, string | number | boolean> = {}
    for (const [k, x] of Object.entries(o)) if (typeof x === 'string' || typeof x === 'number' || typeof x === 'boolean') out[k] = x
    return out
  } catch {
    return {}
  }
}
