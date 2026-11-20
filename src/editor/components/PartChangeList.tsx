import { useEffect, useMemo, useState } from 'react'
import type { PartChange } from '../../core/parts/partChanges'
import type { PartInstance } from '../../core/types'
import { defineMessages, t } from '../../core/i18n'

const M = defineMessages('partChanges', {
  breaking: 'Breaking:',
  placement: 'Placement:',
  more: { one: 'and {count} more change', other: 'and {count} more changes' },
  moreWording: { one: 'and {count} more change to labels or descriptions', other: 'and {count} more changes to labels or descriptions' },
})

/** for each breaking signal change (by param key), what it breaks in this project (plc/updateImpact.ts impactText) */
export type SignalImpacts = ReadonlyMap<string, string>

/** the change lines a list shows before folding the rest into "and N more" */
const SHOWN_CHANGES = 5

/**
 * What each breaking signal change breaks in this project, per part id: the placed copies wired to it and who else
 * uses the tag (plc/updateImpact.ts). Undefined until loaded. Loaded when a review opens, not with the app: it reads
 * the program's ladder, which the first frame has no use for.
 */
export function useSignalImpacts(
  updates: readonly { id: string; changes: PartChange[] }[],
  parts: readonly PartInstance[],
  program: string,
): ReadonlyMap<string, SignalImpacts> | undefined {
  const [impactLib, setImpactLib] = useState<typeof import('../../plc/updateImpact') | null>(null)
  useEffect(() => {
    let open = true
    void import('../../plc/updateImpact')
      .then((m) => open && setImpactLib(m))
      .catch((e: unknown) => console.warn('[oip] the update-impact module failed to load', e))
    return () => {
      open = false
    }
  }, [])
  return useMemo(() => {
    if (!impactLib) return undefined
    const out = new Map<string, SignalImpacts>()
    for (const u of updates) {
      const byKey = impactLib.updateImpact(u.id, u.changes, parts, program)
      out.set(u.id, new Map([...byKey].map(([key, uses]) => [key, impactLib.impactText(uses)])))
    }
    return out
  }, [impactLib, updates, parts, program])
}

/**
 * What taking another version of a part changes, most severe first (core/parts/partChanges.ts). Wording-only changes are
 * counted, not listed. A breaking signal change says what it breaks here once `impacts` has loaded: whether the
 * change is a problem depends on the project.
 */
export function ChangeList({ changes, impacts }: { changes: PartChange[]; impacts?: SignalImpacts }) {
  const listed = changes.filter((c) => c.impact !== 'wording')
  const wording = changes.length - listed.length
  const hidden = Math.max(0, listed.length - SHOWN_CHANGES) + wording
  if (changes.length === 0) return null
  // a signal whose direction and type changed has two lines: say what it breaks here once, on the first
  const said = new Set<string>()
  const impactOf = (c: PartChange): string | undefined => {
    if (c.key === undefined || said.has(c.key) || !impacts?.has(c.key)) return undefined
    said.add(c.key)
    return impacts.get(c.key)
  }
  return (
    <ul className="part-updates-changes" data-testid="part-updates-changes">
      {listed.slice(0, SHOWN_CHANGES).map((c, i) => {
        const here = impactOf(c)
        return (
          <li key={i} className={`part-updates-change ${c.impact}`} data-impact={c.impact}>
            {c.impact === 'breaking' && <strong>{t(M.breaking)}{' '}</strong>}
            {c.impact === 'placement' && <strong>{t(M.placement)}{' '}</strong>}
            {c.text}
            {here !== undefined && (
              <span className="part-updates-impact" data-testid="part-updates-impact">
                {' '}
                {here}
              </span>
            )}
          </li>
        )
      })}
      {hidden > 0 && <li className="part-updates-change">{t(wording === hidden ? M.moreWording : M.more, { count: hidden })}</li>}
    </ul>
  )
}
