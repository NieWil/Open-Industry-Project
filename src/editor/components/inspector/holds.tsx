// The Inspector's Stock row for a part that stores cargo (PartPackage.holds): how many of its positions hold an item,
// and Fill / Empty, which place and remove real cargo parts there (core/heldStock). The stock a run starts with is
// authored like any other cargo, so the stopped scene shows it. Authoring only: disabled while the sim runs.

import { emptyHolds, fillHolds, holdCount, holdsOf } from '../../../core/heldStock'
import { getPackage } from '../../../core/parts/partRegistry'
import type { SceneJSON, SdkPart } from '../../../core/types'
import type { EditorStore } from '../../store/store'
import { defineMessages, t } from '../../../core/i18n'

const M = defineMessages('inspector.holds', {
  countTip: 'Positions holding a {cargo}, of the ones in use',
  count: 'Stock: {filled} of {positions}',
  fillTip: 'Place a {cargo} in every empty position. They are real parts, parented to this one: what a run starts with',
  fill: 'Fill',
  emptyTip: 'Remove the {cargo}s this part holds',
  empty: 'Empty',
})

export function HoldsSection({ store, part, scene, running }: { store: EditorStore; part: SdkPart; scene: SceneJSON; running: boolean }) {
  const h = holdsOf(part)
  const count = h ? holdCount(scene, part) : null
  if (!h || !count) return null
  const cargo = getPackage(h.holds.part)?.name ?? h.holds.part
  const label = h.pkg.name
  // built on the store's current scene, like the Inspector's own update: never a rendered snapshot
  const apply = (verb: string, edit: (s: SceneJSON, id: string) => SceneJSON | null): void => {
    const next = edit(store.getState().scene, part.id)
    if (next) store.commit(`${verb} ${label}`, next)
  }
  return (
    <div className="inspector-holds">
      <div className="inspector-holds-count" title={t(M.countTip, { cargo })}>
        {t(M.count, { filled: count.filled, positions: count.positions })}
      </div>
      <div className="rig-script-actions">
        <button
          type="button"
          className="array-add"
          disabled={running || count.filled >= count.positions}
          title={t(M.fillTip, { cargo })}
          onClick={() => apply('Fill', fillHolds)}
        >
          {t(M.fill)}
        </button>
        <button
          type="button"
          className="array-add"
          disabled={running || count.filled === 0}
          title={t(M.emptyTip, { cargo })}
          onClick={() => apply('Empty', emptyHolds)}
        >
          {t(M.empty)}
        </button>
      </div>
    </div>
  )
}
