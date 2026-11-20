// The main button of a shelf part's catalog card when this project has no copy of it yet: pressing it places the part.
// `beforePlace` runs at the press, synchronously, so a part copied into the project there is found by the placement
// that starts in the same handler.

import type { PartPackage } from '../../core/parts/partPackage'
import type { EditorController } from '../controller'
import type { EditorState } from '../store/store'
import { PartGlyph } from './toolbarIcons'

interface Props {
  pkg: Pick<PartPackage, 'id' | 'name'>
  blocked: boolean
  title: string
  state: EditorState
  controller: EditorController | null
  /** the card image's URL, or none for the generic glyph */
  image: string | undefined
  beforePlace?: () => void
}

export function CatalogPlaceButton({ pkg, blocked, title, state, controller, image, beforePlace }: Props) {
  const active = state.mode === 'placing' && state.placingType === 'part' && state.placingPackageId === pkg.id
  return (
    <button
      className={`catalog-card-main${active ? ' active' : ''}`}
      data-part-type="part"
      data-package-id={pkg.id}
      disabled={blocked}
      title={title}
      onClick={(e) => {
        // keyboard activation (Enter/Space): click-to-place from the card's centre, as the other cards do
        if (e.detail !== 0 || !controller) return
        beforePlace?.()
        const r = e.currentTarget.getBoundingClientRect()
        controller.beginCatalogPlace('part', r.left + r.width / 2, r.top + r.height / 2, pkg.id)
        controller.endCatalogPlace(r.left + r.width / 2, r.top + r.height / 2, false)
      }}
      onPointerDown={(e) => {
        if (blocked || e.button !== 0 || !controller) return
        e.preventDefault()
        beforePlace?.()
        e.currentTarget.setPointerCapture(e.pointerId)
        controller.beginCatalogPlace('part', e.clientX, e.clientY, pkg.id)
      }}
      onPointerMove={(e) => controller?.catalogPlaceMove(e.clientX, e.clientY, e.altKey)}
      onPointerUp={(e) => {
        if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
        controller?.endCatalogPlace(e.clientX, e.clientY, e.altKey)
      }}
      onPointerCancel={(e) => {
        if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
        controller?.cancelCatalogPlace()
      }}
    >
      <span className="catalog-card-thumb">
        {image ? (
          <img src={image} alt="" draggable={false} />
        ) : (
          <span className="catalog-card-glyph"><PartGlyph /></span>
        )}
      </span>
      <span className="catalog-card-label">{pkg.name}</span>
    </button>
  )
}
