import { useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { effectivelyHiddenSet } from '../../core/scene/hierarchy'
import { annotationGlyph } from '../../core/types'
import type { AnnotationPart, PartInstance } from '../../core/types'
import type { IRenderView } from '../../render/api'
import { whenCoverHidden } from '../../render/renderReady'
import { chipViews, chipsKey, readoutText } from '../annotationChips'
import type { ChipProjection, ChipView } from '../annotationChips'
import type { EditorController } from '../controller'
import { focusViewScene } from '../controller/viewScene'
import { editTarget, editTargetFocusId } from '../store/store'
import type { EditorState, EditorStore } from '../store/store'

/**
 * Scene annotations, drawn as screen-space chips over the viewport - the icon + caption a person pins to a
 * place to explain the layout.
 *
 * The chip is DOM, not scene geometry, so it stays the same readable size wherever the
 * camera is, faces you from every angle, and can't be walked into. A sign modelled on a wall would have none
 * of those properties, and a note is about the layout rather than part of it.
 *
 * It follows its spot through `view.worldToScreen`, the same projection the tutorial's placement hint uses.
 * Selection goes the other way round from every other part: there is nothing in the 3-D scene to hit, so the
 * chip is the hit target and clicking it selects the annotation - after which the ordinary transform gizmo
 * (attached to the annotation's empty transform) moves it like anything else. That click needs `.note-chip`
 * in the viewport controller's overlay opt-out, or the viewport captures the pointer and eats it.
 *
 * The frame loop reads the scene from the store, not from props: a placement preview and a
 * drag are pushed as transients (store.setTransient), which by design do not re-render the React chrome
 * (the panels would starve the render loop). Reading through props means a note being placed or
 * dragged is invisible until the commit, which is exactly when you need to see where it is going. The loop
 * already runs every frame, so reading the live scene there adds no work and includes the transients.
 */
interface HiddenMemo {
  parts: readonly PartInstance[] | null
  focusId: string | null
  hidden: Set<string>
}

/**
 * The parts the viewport is not drawing: hidden by their own eye toggle or an ancestor's, or by an open part scene
 * (focusViewScene hides everything outside the focused part). It reads the same view scene the viewport draws, so a
 * chip shows exactly when its spot does. Recomputed only when the scene or the focus changes, not every frame.
 */
function hiddenNotes(memo: HiddenMemo, s: EditorState): Set<string> {
  const target = editTarget(s)
  const focusId = target ? editTargetFocusId(target) : null
  if (memo.parts === s.scene.parts && memo.focusId === focusId) return memo.hidden
  const parts = focusId ? focusViewScene(s.scene, focusId).parts : s.scene.parts
  memo.parts = s.scene.parts
  memo.focusId = focusId
  memo.hidden = effectivelyHiddenSet(parts)
  return memo.hidden
}

interface AnnotationOverlayProps {
  store: EditorStore
  view: IRenderView | null
  /** live PLC tag values for a note bound to one; null while no program is attached */
  controller: EditorController | null
  /** the View → Show Annotations toggle; off renders nothing at all */
  show: boolean
}

export function AnnotationOverlay({ store, view, controller, show }: AnnotationOverlayProps): ReactElement | null {
  const [chips, setChips] = useState<ChipView[]>([])
  const lastKey = useRef('')
  const layerRef = useRef<HTMLDivElement>(null)
  // Nothing until the loading cover has lifted: before the reveal there is no settled camera to project
  // against, so a chip drawn then would be in the wrong place.
  // That signal is capped at 4 s (renderReady.ts, so the deferred warm cannot be stranded), so on a slow first load
  // chips can exist while the cover is still up. They cannot paint over it: the layer sits under the whole
  // viewport HUD band by z-index (styles.css: .note-layer 4, the cover 7), which e2e/verify-annotations.mjs checks.
  const [revealed, setRevealed] = useState(false)
  useEffect(() => {
    let alive = true
    void whenCoverHidden()
      .then(() => {
        if (alive) setRevealed(true)
      })
      .catch((e: unknown) => console.warn('[oip] annotation reveal failed', e))
    return () => {
      alive = false
    }
  }, [])

  useEffect(() => {
    if (!show || !view || !revealed) {
      lastKey.current = ''
      setChips((prev) => (prev.length === 0 ? prev : []))
      return
    }
    let raf = 0
    const hiddenMemo: HiddenMemo = { parts: null, focusId: null, hidden: new Set() }
    const loop = (): void => {
      raf = requestAnimationFrame(loop)
      const s = store.getState()
      const pose = view.cameraPose()
      // The running program's variable image, memoized on the frame's watch object - so reading it per note
      // per frame is a map lookup, not a re-derive. Null while nothing is attached, which means
      // "there is no program to read" and shows every bound note's blank readout.
      const tags = controller?.plcGlobalTags ?? null
      // worldToScreen answers in page coords; the layer is positioned inside the viewport (so the viewport's
      // overflow clips a chip at its edge instead of letting it hang over the docks), so chips place relative to it.
      const origin = layerRef.current?.getBoundingClientRect()
      const ox = origin?.left ?? 0
      const oy = origin?.top ?? 0
      const hidden = hiddenNotes(hiddenMemo, s)
      const projections: ChipProjection[] = []
      for (const part of s.scene.parts) {
        if (part.type !== 'annotation') continue
        const note = part as AnnotationPart
        if (hidden.has(note.id)) continue
        const [x, y, z] = note.position
        const p = view.worldToScreen(x, y, z)
        projections.push({
          id: note.id,
          x: p.x - ox,
          y: p.y - oy,
          visible: p.visible,
          distance: Math.hypot(x - pose.px, y - pose.py, z - pose.pz),
          text: note.params.text,
          glyph: annotationGlyph(note.params.icon),
          // A note with no tag stays a plain caption: no value slot, no dash. Only a note that asks for a
          // reading shows one, so a blank readout always means "this is bound to something that isn't there".
          value: note.params.tag ? readoutText(tags?.[note.params.tag], note.params.decimals, note.params.unit) : '',
          selected: s.selectedIds.includes(note.id),
        })
      }
      const next = chipViews(projections)
      // Repaint only when the rounded placement or the content actually changed. Without this the overlay
      // re-renders every frame forever - including while the camera sits still - which is the cost that
      // makes people distrust DOM overlays over a 3-D scene.
      const key = chipsKey(next)
      if (key === lastKey.current) return
      lastKey.current = key
      setChips(next)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [show, view, store, controller, revealed])

  // A chip is scene content, so scrolling over one zooms the scene like scrolling anywhere else in it. The
  // chip, not the canvas, is under the cursor, so without this the chip takes the wheel event and the scene does not zoom: on a scene full of
  // notes a long zoom-out stalls wherever one drifts under the pointer. Native and non-passive (React's
  // onWheel is passive), because the zoom prevents the page's own scroll and pinch-zoom.
  useEffect(() => {
    const layer = layerRef.current
    if (!layer || !view) return
    const onWheel = (e: WheelEvent): void => view.zoomWheel(e)
    layer.addEventListener('wheel', onWheel, { passive: false })
    return () => layer.removeEventListener('wheel', onWheel)
  }, [view, show, revealed])

  // The layer stays mounted while chips are empty: the frame loop measures it for the page -> layer offset.
  if (!show || !revealed) return null

  return (
    <div className="note-layer" ref={layerRef}>
      {chips.map((chip) => (
        <button
          type="button"
          key={chip.id}
          className={`note-chip${chip.selected ? ' selected' : ''}`}
          style={{ left: chip.x, top: chip.y, opacity: chip.opacity }}
          data-note-id={chip.id}
          title={chip.text}
          onPointerDown={(e) => {
            // don't let the viewport treat this as a scene click
            e.stopPropagation()
            // Only the left button belongs to the chip. A middle or right press is camera navigation, which
            // listens on the canvas, so hand it there. preventDefault stops the middle button's autoscroll.
            if (e.button !== 0 && view) {
              e.preventDefault()
              view.pointerDownThrough(e.nativeEvent)
            }
          }}
          // a display link (locked Present) shows notes but does not select them
          onClick={() => !store.getState().presentLocked && store.select(chip.id)}
        >
          {chip.glyph && <span className="note-chip-icon">{chip.glyph}</span>}
          <span className="note-chip-text">{chip.text}</span>
          {chip.value && <span className="note-chip-value">{chip.value}</span>}
        </button>
      ))}
    </div>
  )
}
