// What the running controller faulted on, as the PLC panel shows it. The controller's record (editor/controller.ts
// `plcFaults`) holds the positioned fault that stopped the scan (a division by zero, an array bound), so the panel owns
// this, and the ladder sheet draws the fault on the element it happened in.

import { useEffect, useMemo, useRef, useState } from 'react'
import type { Diagnostic } from '../../../plc'
import type { EditorController, PlcFaults } from '../../controller'
import type { PlcFace } from './plcPanelParts'

/** The faults as the panel hands them to its parts. */
export interface PanelFaults {
  /** what the controller faulted on, against the source it happened in; it outlives the run, until the next one */
  faults: PlcFaults | null
  /** those faults as problems of the elements they happened in, while the sheet still shows that program */
  marks: readonly Diagnostic[]
  /** select the element a fault happened in (`n` makes each ask new) */
  reveal: { offset: number; n: number } | null
  /** take the reader to where a fault happened: the sheet selects the element, the text editor puts the caret there */
  show: (offset: number | undefined) => void
}

const NO_MARKS: Diagnostic[] = []

export function usePlcFaults({ controller, ladderSource, face, showText }: {
  controller: EditorController | null
  ladderSource: string
  face: PlcFace
  showText: (offset: number) => void
}): PanelFaults {
  const [faults, setFaults] = useState<PlcFaults | null>(null)
  const [reveal, setReveal] = useState<{ offset: number; n: number } | null>(null)
  const latest = useRef({ controller, face, showText })
  latest.current = { controller, face, showText }

  // Kept after the program stops, until the next run. Only which fault stands where redraws the rungs.
  const seen = useRef('')
  const read = useRef<() => void>(() => {})
  read.current = (): void => {
    const f = latest.current.controller?.plcFaults
    if (!f) return
    const places = `${f.source.length}|${f.fault?.message ?? ''}`
    if (places === seen.current) return
    seen.current = places
    setFaults(f.fault ? f : null)
  }
  // A fault arrives as a status change: the program has just stopped, and the controller writes the fault
  // before the status goes out (editor/controller.ts), so it is read on the status change.
  useEffect(() => {
    if (!controller) return
    read.current()
    return controller.onProgramStatus(() => read.current())
  }, [controller])

  // On the element it happened in, in the errors' red, but only while the sheet still shows the program it happened
  // in, since an edit moves every offset after it
  const marks = useMemo((): readonly Diagnostic[] => {
    if (!faults || faults.source !== ladderSource) return NO_MARKS
    const at = (f: { offset?: number; line?: number; col?: number }): Diagnostic['pos'] => ({ offset: f.offset ?? 0, line: f.line ?? 1, col: f.col ?? 1 })
    return faults.fault?.offset !== undefined ? [{ message: faults.fault.message, pos: at(faults.fault), length: 1 }] : NO_MARKS
  }, [faults, ladderSource])

  const show = (offset: number | undefined): void => {
    if (offset === undefined) return
    if (latest.current.face === 'ladder') setReveal((r) => ({ offset, n: (r?.n ?? 0) + 1 }))
    else latest.current.showText(offset)
  }

  return { faults, marks, reveal, show }
}
