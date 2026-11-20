import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import type { CSSProperties } from 'react'
import { isolateHistory } from '@codemirror/commands'
import { Compartment, EditorState, Prec, Transaction } from '@codemirror/state'
import { forceLinting } from '@codemirror/lint'
import type { Extension } from '@codemirror/state'
import { EditorView, keymap, placeholder, runScopeHandlers } from '@codemirror/view'
import { unfoldAll } from '@codemirror/language'
import { changedSpan } from '../../../core/textDiff'
import type { TagValue, WatchInstance } from '../../../plc'
import { docText } from '../../program/docText'
import { pushWatchValues, stExtensions } from '../../program/stLang'
import { foldDeclarations } from '../../program/stFolding'
import { watchNameAt, watchNameOfSelection } from '../../program/plcWatchList'
import type { Controller } from '../../../core/controller'

/** CodeMirror's own test for which modifier `Mod` is: Cmd on a Mac, Ctrl elsewhere (a key replayed through it has to
 *  carry the modifier its keymap reads) */
const MAC = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform)

// Ghost text shown only while the editor is empty (a fresh load, or after you clear it):
// a minimal Structured Text skeleton so the declaration-block structure is discoverable
// without seeding real content - it isn't part of the document, so it's never saved, run,
// or bundled into an exported scene. Inputs map to sensors/buttons and outputs to
// actuators via each part's "PLC tag" (see the Inspector tip below the editor).
const ST_PLACEHOLDER = `VAR_INPUT
  Start : BOOL;
END_VAR
VAR_OUTPUT
  Motor : BOOL;
END_VAR

Motor := Start;`

/** Imperative handle so the parent can read/replace the buffer (e.g. "Load demo"). */
export interface StCodeEditorHandle {
  getValue: () => string
  setValue: (value: string) => void
  /**
   * Bring the buffer to `value` without a step in this editor's history: a program edit that the project's undo owns
   * (store.commitProgram). Only the span that differs is replaced, so the history of what was typed around it still
   * maps onto the document.
   */
  applyEdit: (value: string) => void
  /**
   * Bring the buffer to `value` as one step of this editor's own history (a room's shared one when bound): an edit made
   * elsewhere in the panel, the ladder view's, that Ctrl+Z here takes back like typing. Only the span that differs is
   * replaced.
   */
  edit: (value: string) => void
  /** Ctrl+Z / Ctrl+Y, as if pressed in the editor: the panel's program undo first, then this editor's history */
  undo: () => void
  redo: () => void
  /** where the caret is, and the identifier under it if any (what a command about "the name here" starts from) */
  caret: () => { offset: number; word: string | null } | null
  /**
   * What a right-click at (x, y) is on, for the panel's menu: a click inside the selection keeps it, anywhere else puts
   * the caret there first, as text editors do. `name` is the variable there (plcWatchList.ts `watchNameAt`, or the
   * selection when it is one place), `selected` the selected text, and `at` where to open the menu. Without a point
   * (the menu key) it answers for the caret.
   */
  contextAt: (point: { x: number; y: number } | null) => { name: string | null; selected: string; at: { x: number; y: number } } | null
  /** replace the selection with `text` (Paste, Cut), as one step of this editor's history */
  replaceSelection: (text: string, userEvent: 'input.paste' | 'delete.cut') => void
  selectAll: () => void
  /** put the keyboard in the text, keeping the selection where it was */
  focus: () => void
  /** fold every VAR section, TYPE and STRUCT (stFolding.ts); false when there was none left to fold */
  foldDeclarations: () => boolean
  /** open every folded block; false when none was folded */
  unfoldAll: () => boolean
  /** re-measure: the editor was hidden (`display: none`, under another view of the panel) and is back on screen */
  refresh: () => void
  /** push the live variable image for inline value overlays, with the program instances that run it; `{}` clears them */
  setWatchValues: (
    values: Readonly<Record<string, TagValue>>,
    instances?: readonly WatchInstance[],
    picked?: Readonly<Record<string, string>>,
    pick?: (type: string, instance: string) => void,
  ) => void
  /**
   * Put the cursor at `offset` and scroll it to the top of the viewport.
   *
   * This is how the block strip navigates. It moves the view, never the document: one
   * CodeMirror state over the whole program, so the collaborative `Y.Text` binding and the
   * shared undo history are untouched by jumping between POUs.
   */
  revealOffset: (offset: number) => void
}

interface StCodeEditorProps {
  /** initial document; the editor owns the buffer thereafter (set via the handle) */
  initialValue: string
  /** fired on every edit with the full document */
  onChange: (value: string) => void
  /** live scene comms tags, read lazily per completion request */
  getTags: () => string[]
  /** the scene's controller table and scan time, read on each lint pass: the program is checked together with them */
  getProgram?: () => { controller: Controller | null; scanMs: number }
  /** the default controller's name, which a task may spell (plc controllerDiagnostics) */
  getDefaultPlc?: () => string | undefined
  /** false while the program is in a dialect this build does not read: no lint pass then (default true) */
  lints?: boolean
  /** invoked by Ctrl/Cmd-Enter (not F5, see the keymap below): the panel starts a stopped sim or reloads a running one */
  onRun?: () => void
  /** asked first on Ctrl+Z: true when the panel undid a program edit instead (see store.undoProgramEditAt) */
  onUndo?: () => boolean
  /** asked first on Ctrl+Y / Ctrl+Shift+Z: true when the panel redid a program edit instead */
  onRedo?: () => boolean
  /**
   * Collaborative binding (room mode): the y-codemirror.next extension that syncs this editor
   * to the shared Y.Text. When present, the document is owned by the Y.Text (so `initialValue`
   * is ignored) and CodeMirror's local history is replaced by the Yjs-backed shared undo.
   */
  collabExtension?: Extension
  /**
   * View-only (shared read-only link): make CodeMirror non-editable so the viewer can't type
   * into the shared program. Remote edits still apply (read-only blocks user input, not the
   * collab extension's programmatic dispatches), so the viewer sees the program update live.
   */
  readOnly?: boolean
  /** where the reader is, as a document offset (see {@link readingPosition}); at most once a frame, on a cursor move, an
   *  edit, a scroll or a resize */
  onReadingPosition?: (offset: number) => void
  /** once, when the view exists: the handle is set before it is (the view is built in an effect), so a request that
   *  arrived while this lazy chunk was loading is served from here */
  onReady?: () => void
  style?: CSSProperties
}

/**
 * The cursor while it is on screen, else the first line at the top of the view.
 *
 * The cursor alone would go stale the moment the wheel scrolls it away, and the top of the view alone is wrong for a
 * short last block, which a reveal cannot scroll up to the top.
 */
function readingPosition(view: EditorView): number {
  const box = view.scrollDOM.getBoundingClientRect()
  const top = box.top - view.documentTop
  const bottom = box.bottom - view.documentTop
  const head = view.state.selection.main.head
  const line = view.lineBlockAt(head)
  if (line.bottom > top && line.top < bottom) return head
  return view.lineBlockAtHeight(Math.max(0, top)).from
}

/**
 * Thin React shell around a CodeMirror 6 `EditorView`. CM owns the document (it is not
 * a controlled input); edits flow out via `onChange`, and the parent pushes new content
 * in through the imperative handle. Created once and destroyed on unmount.
 */
/** What read-only means for the editor: no typing, and no caret claiming it could type. */
function readOnlyExtension(readOnly: boolean | undefined): Extension {
  return readOnly ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : []
}

export const StCodeEditor = forwardRef<StCodeEditorHandle, StCodeEditorProps>(function StCodeEditor(
  { initialValue, onChange, getTags, getProgram, getDefaultPlc, lints = true, onRun, onUndo, onRedo, collabExtension, readOnly, onReadingPosition, onReady, style },
  ref,
) {
  // captured once: the editor is built a single time in the mount effect
  const collabRef = useRef(collabExtension)
  const readOnlyRef = useRef(readOnly)
  // ...except whether it may be typed into, which a wholesale load can change under a mounted editor (a program in a
  // dialect this build does not read is shown read-only), so it sits in a compartment the effect below reconfigures
  const readOnlyCompartment = useRef(new Compartment())
  const host = useRef<HTMLDivElement | null>(null)
  const view = useRef<EditorView | null>(null)
  // latest callbacks behind refs so the view (built once) never holds a stale closure
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const getTagsRef = useRef(getTags)
  getTagsRef.current = getTags
  const getProgramRef = useRef(getProgram)
  getProgramRef.current = getProgram
  const getDefaultPlcRef = useRef(getDefaultPlc)
  getDefaultPlcRef.current = getDefaultPlc
  const lintsRef = useRef(lints)
  lintsRef.current = lints
  const onRunRef = useRef(onRun)
  onRunRef.current = onRun
  const onUndoRef = useRef(onUndo)
  onUndoRef.current = onUndo
  const onRedoRef = useRef(onRedo)
  onRedoRef.current = onRedo
  const onReadingPositionRef = useRef(onReadingPosition)
  onReadingPositionRef.current = onReadingPosition
  const onReadyRef = useRef(onReady)
  onReadyRef.current = onReady
  const initialRef = useRef(initialValue)

  useEffect(() => {
    if (!host.current) return
    // a PLC-style "run" binding; placed ahead of stExtensions so it wins over the
    // default Mod-Enter (insert blank line). We don't bind F5 - the browser owns it
    // (reload, and Ctrl-F5 hard-reload can't be preventDefault'd), so Ctrl/Cmd-Enter is
    // the reliable, conflict-free key.
    const runKey = (): boolean => {
      onRunRef.current?.()
      return true
    }
    // in a room the shared Y.Text owns the document; CM's local history is dropped in favour
    // of the Yjs-backed shared undo that the collab extension brings
    const collab = collabRef.current
    // the reading position is layout, so it is read in a frame, and a scroll burst reports once per frame
    // (the editor's own window: in a popped-out panel the main window may be minimised, and its frames stop)
    const win = host.current.ownerDocument.defaultView ?? window
    let frame = 0
    const reportPosition = (): void => {
      if (frame !== 0 || !onReadingPositionRef.current) return
      frame = win.requestAnimationFrame(() => {
        frame = 0
        if (view.current) onReadingPositionRef.current?.(readingPosition(view.current))
      })
    }
    const v = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: docText(initialRef.current),
        extensions: [
          keymap.of([{ key: 'Mod-Enter', preventDefault: true, run: runKey }]),
          // undo and redo ask the panel first: a program edit newer than anything typed here is taken back whole by
          // the project's undo; anything else falls through to this editor's own history (or the room's binding)
          Prec.high(
            keymap.of([
              { key: 'Mod-z', run: () => onUndoRef.current?.() ?? false },
              { key: 'Mod-y', mac: 'Mod-Shift-z', run: () => onRedoRef.current?.() ?? false },
              { linux: 'Mod-Shift-z', run: () => onRedoRef.current?.() ?? false },
            ]),
          ),
          placeholder(ST_PLACEHOLDER),
          stExtensions(() => getTagsRef.current(), {
            ...(collab ? { history: false } : {}),
            ...(getProgramRef.current ? { getProgram: () => getProgramRef.current!() } : {}),
            getDefaultPlc: () => getDefaultPlcRef.current?.(),
            lints: () => lintsRef.current,
          }),
          ...(collab ? [collab] : []),
          // a view-only client can read + scroll the shared program but not type into it
          readOnlyCompartment.current.of(readOnlyExtension(readOnlyRef.current)),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) onChangeRef.current(u.state.doc.toString())
            if (u.docChanged || u.selectionSet || u.geometryChanged || u.viewportChanged) reportPosition()
          }),
        ],
      }),
    })
    view.current = v
    // a wheel scroll that stays inside the rendered viewport fires no update, so the scroller is watched too
    v.scrollDOM.addEventListener('scroll', reportPosition, { passive: true })
    reportPosition()
    onReadyRef.current?.()
    return () => {
      win.cancelAnimationFrame(frame)
      v.scrollDOM.removeEventListener('scroll', reportPosition)
      v.destroy()
      view.current = null
    }
  }, [])

  // the read-only switch and the lint switch, after the editor exists: reconfigure it, and re-lint so the gutter matches
  useEffect(() => {
    const v = view.current
    if (!v) return
    v.dispatch({ effects: readOnlyCompartment.current.reconfigure(readOnlyExtension(readOnly)) })
  }, [readOnly])
  useEffect(() => {
    if (view.current) forceLinting(view.current)
  }, [lints])

  useImperativeHandle(ref, () => ({
    getValue: () => view.current?.state.doc.toString() ?? initialRef.current,
    setValue: (value: string) => {
      const v = view.current
      if (!v || value === v.state.doc.toString()) return
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: docText(value) } })
    },
    applyEdit: (value: string) => {
      const v = view.current
      if (!v) return
      const current = v.state.doc.toString()
      if (value === current) return
      const { from, removed, inserted } = changedSpan(current, value)
      v.dispatch({
        changes: { from, to: from + removed, insert: docText(inserted) },
        annotations: [Transaction.addToHistory.of(false), isolateHistory.of('full')],
      })
    },
    edit: (value: string) => {
      const v = view.current
      if (!v) return
      const current = v.state.doc.toString()
      if (value === current) return
      const { from, removed, inserted } = changedSpan(current, value)
      v.dispatch({ changes: { from, to: from + removed, insert: docText(inserted) }, annotations: [isolateHistory.of('full')], userEvent: 'input.ladder' })
    },
    // through the editor's own key handling, so it is exactly what Ctrl+Z / Ctrl+Y there would do, in a room too
    undo: () => {
      const v = view.current
      if (v) runScopeHandlers(v, new KeyboardEvent('keydown', MAC ? { key: 'z', metaKey: true } : { key: 'z', ctrlKey: true }), 'editor')
    },
    redo: () => {
      const v = view.current
      if (v) runScopeHandlers(v, new KeyboardEvent('keydown', MAC ? { key: 'z', metaKey: true, shiftKey: true } : { key: 'y', ctrlKey: true }), 'editor')
    },
    caret: () => {
      const v = view.current
      if (!v) return null
      const offset = v.state.selection.main.head
      const range = v.state.wordAt(offset)
      const word = range ? v.state.sliceDoc(range.from, range.to) : null
      return { offset, word: word && /^[A-Za-z_][A-Za-z0-9_]*$/.test(word) ? word : null }
    },
    contextAt: (point) => {
      const v = view.current
      if (!v) return null
      const sel = v.state.selection.main
      const pos = point ? v.posAtCoords(point) : sel.head
      if (pos !== null && (sel.empty || pos < sel.from || pos > sel.to)) v.dispatch({ selection: { anchor: pos } })
      v.focus()
      const s = v.state.selection.main
      const selected = v.state.sliceDoc(s.from, s.to)
      let name: string | null = null
      if (!s.empty) name = watchNameOfSelection(selected)
      else if (pos !== null) {
        const line = v.state.doc.lineAt(pos)
        name = watchNameAt(line.text, pos - line.from)
      }
      const c = point ?? v.coordsAtPos(s.head) ?? v.dom.getBoundingClientRect()
      return { name, selected, at: { x: 'x' in c ? c.x : c.left, y: 'y' in c ? c.y : c.bottom } }
    },
    replaceSelection: (text, userEvent) => {
      const v = view.current
      if (!v) return
      v.dispatch(v.state.replaceSelection(text), { userEvent, scrollIntoView: true })
      v.focus()
    },
    foldDeclarations: () => (view.current ? foldDeclarations(view.current) : false),
    unfoldAll: () => (view.current ? unfoldAll(view.current) : false),
    selectAll: () => {
      const v = view.current
      if (!v) return
      v.dispatch({ selection: { anchor: 0, head: v.state.doc.length } })
      v.focus()
    },
    focus: () => view.current?.focus(),
    refresh: () => view.current?.requestMeasure(),
    setWatchValues: (values, instances, picked, pick) => {
      if (view.current) pushWatchValues(view.current, values, instances, picked, pick)
    },
    revealOffset: (offset: number) => {
      const v = view.current
      if (!v) return
      const at = Math.max(0, Math.min(offset, v.state.doc.length))
      v.dispatch({ selection: { anchor: at }, effects: EditorView.scrollIntoView(at, { y: 'start' }) })
      v.focus()
    },
  }), [])

  return <div ref={host} style={style} />
})
