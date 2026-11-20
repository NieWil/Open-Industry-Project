// The Inspector's Controller row: which PLC every tag of the selected parts is on (`Cell2::%IX0.0`,
// core/io/controllerTag.ts), set for all of them at once, since a device is wired to one PLC. It shows once the
// project has a controller besides the default one and the selection has a tag. A pick moves every tag, as Assign to
// Controller does (program/assignController.ts), in one undo step. It is drawn above the part's first tag field, so it
// sits with the tags in their section (ParamField draws it from ControllerRowContext).
//
// While the row names one controller, the tag fields below hide their own pickers and a tag typed into an empty field
// goes on that controller (TagSources.partController). When the tags disagree, the row says so and each field shows
// its own picker, so the odd one out can be seen and moved.

import { useContext } from 'react'
import type { ReactNode } from 'react'
import type { PartInstance } from '../../../core/types'
import { commitControllerAssignment, tagControllers } from '../../program/assignController'
import type { EditorStore } from '../../store/store'
import { RevertSlot } from './fields'
import { ControllerRowContext, TagSourcesContext } from './tagField'
import { defineMessages, t } from '../../../core/i18n'

const M = defineMessages('inspector.controllerRow', {
  label: 'Controller',
  title: 'The PLC every tag of this part is on. A pick moves them all.',
  program: 'Program',
  external: 'External PLC',
  mixed: 'Mixed',
  undoProgram: 'Assign to the program',
  undoExternal: 'Assign to the external PLC',
  undoNamed: 'Assign to {name}',
})

/** the mixed option's value: `::` is in no controller name, so no option can share it */
const MIXED = '::'

/** The Controller row, when it applies, for `children` (the part's fields), which see what it names. */
export function ControllerScope({
  store,
  parts,
  firstTag,
  children,
}: {
  store: EditorStore
  parts: readonly PartInstance[]
  firstTag: string | undefined
  children: ReactNode
}) {
  const sources = useContext(TagSourcesContext)
  const on = tagControllers(parts)
  const shown = sources !== null && sources.controllers.length > 0 && on.length > 0 && firstTag !== undefined
  // the controller every tag is on, as the project spells it (names ignore case); undefined while they disagree
  const spell = (c: string | null): string | null => (c === null ? null : (sources?.controllers.find((k) => k.toLowerCase() === c.toLowerCase()) ?? c))
  const one = shown && on.length === 1 ? spell(on[0]!) : undefined
  // a pick rewrites tags a running program's links were bound to, so it waits for Stop, as Assign to Controller does
  const s = store.getState()
  const locked = s.running || s.readOnly
  const row = shown ? (
    <ControllerRow
      store={store}
      parts={parts}
      one={one}
      named={[...sources.controllers, ...on.filter((c): c is string => c !== null && !sources.controllers.some((k) => k.toLowerCase() === c.toLowerCase()))]}
      external={sources.external}
      locked={locked}
    />
  ) : null
  return (
    <ControllerRowContext.Provider value={row ? { above: firstTag!, row } : null}>
      <TagSourcesContext.Provider value={sources && one !== undefined ? { ...sources, partController: one } : sources}>{children}</TagSourcesContext.Provider>
    </ControllerRowContext.Provider>
  )
}

function ControllerRow({
  store,
  parts,
  one,
  named,
  external,
  locked,
}: {
  store: EditorStore
  parts: readonly PartInstance[]
  one: string | null | undefined
  named: readonly string[]
  external: boolean
  locked: boolean
}) {
  const ids = parts.map((p) => p.id)
  const pick = (value: string): void => {
    const next = value === '' ? null : value
    const label = next !== null ? t(M.undoNamed, { name: next }) : t(external ? M.undoExternal : M.undoProgram)
    commitControllerAssignment(store, ids, next, ids.length > 1 ? `${label} (${ids.length})` : label)
  }
  return (
    <label className="field" data-testid="part-controller">
      <span className="field-label" title={t(M.title)}>
        {t(M.label)}
      </span>
      <span className="field-control">
        <select value={one === undefined ? MIXED : (one ?? '')} title={t(M.title)} disabled={locked} onChange={(e) => pick(e.target.value)} data-testid="part-controller-select">
          {one === undefined && (
            <option value={MIXED} disabled>
              {t(M.mixed)}
            </option>
          )}
          <option value="">{t(external ? M.external : M.program)}</option>
          {named.map((c) => (
            <option key={c} value={c}>
              {/* i18n-ok: the controller's name, as the tags spell it */}
              {c}
            </option>
          ))}
        </select>
        <RevertSlot />
      </span>
    </label>
  )
}
